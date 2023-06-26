import type { FloatingConfig } from '$lib/internal/actions';
import { usePopper } from '$lib/internal/actions/popper';
import {
	derivedWithUnsubscribe,
	effect,
	isBrowser,
	kbd,
	sleep,
	styleToString,
	generateId,
	isHTMLElement,
	isElementDisabled,
	debounce,
	noop,
	executeCallbacks,
	addEventListener,
	hiddenAction,
} from '$lib/internal/helpers';
import type { Defaults } from '$lib/internal/types';
import { onMount, tick } from 'svelte';
import { derived, get, writable, type Writable } from 'svelte/store';

type Direction = 'ltr' | 'rtl';

const SELECTION_KEYS = [kbd.ENTER, kbd.SPACE];
const FIRST_KEYS = [kbd.ARROW_DOWN, kbd.PAGE_UP, kbd.HOME];
const LAST_KEYS = [kbd.ARROW_UP, kbd.PAGE_DOWN, kbd.END];
const FIRST_LAST_KEYS = [...FIRST_KEYS, ...LAST_KEYS];
const SUB_OPEN_KEYS: Record<Direction, string[]> = {
	ltr: [...SELECTION_KEYS, kbd.ARROW_RIGHT],
	rtl: [...SELECTION_KEYS, kbd.ARROW_LEFT],
};
const SUB_CLOSE_KEYS: Record<Direction, string[]> = {
	ltr: [kbd.ARROW_LEFT],
	rtl: [kbd.ARROW_RIGHT],
};

export type CreateDropdownMenuArgs = {
	positioning?: FloatingConfig;
	arrowSize?: number;
	disabled?: boolean;
	name?: string;
};

const defaults = {
	arrowSize: 8,
	disabled: false,
	positioning: {
		placement: 'bottom',
	},
} satisfies Defaults<CreateDropdownMenuArgs>;

export function createDropdownMenu(args?: CreateDropdownMenuArgs) {
	const withDefaults = { ...defaults, ...args } as CreateDropdownMenuArgs;
	const rootOptions = writable(withDefaults);

	const rootOpen = writable(false);
	const rootActiveTrigger = writable<HTMLElement | null>(null);

	const lastPointerX = writable(0);
	const isUsingKeyboard = writable(false);
	const pointerGraceIntent = writable<GraceIntent | null>(null);
	const pointerDir = writable<Side>('right');

	let typed: string[] = [];
	const resetTyped = debounce(() => {
		typed = [];
	});

	const handleTypeaheadSearch = (key: string, menuItems: HTMLElement[]) => {
		typed.push(key.toLowerCase());
		const typedString = typed.join('');
		const matchingOption = menuItems.find((el) =>
			el.innerText.toLowerCase().startsWith(typedString)
		);
		if (matchingOption) {
			handleRovingFocus(matchingOption);
		}

		resetTyped();
	};

	const pointerMovingToSubmenu = derivedWithUnsubscribe(
		[pointerDir, pointerGraceIntent],
		([$pointerDir, $pointerGraceIntent]) => {
			return (e: PointerEvent) => {
				const isMovingTowards = $pointerDir === $pointerGraceIntent?.side;

				return isMovingTowards && isPointerInGraceArea(e, $pointerGraceIntent?.area);
			};
		}
	);

	const rootIds = {
		menu: generateId(),
		trigger: generateId(),
	};

	const rootMenu = {
		...derived([rootOpen], ([$rootOpen]) => {
			return {
				role: 'menu',
				hidden: $rootOpen ? undefined : true,
				style: styleToString({
					display: $rootOpen ? undefined : 'none',
				}),
				id: rootIds.menu,
				'aria-labelledby': rootIds.trigger,
				'data-melt-part': 'menu-root',
				'data-melt-menu': '',
				'data-melt-id': rootIds.menu,
				tabindex: -1,
			} as const;
		}),
		action: (node: HTMLElement) => {
			let unsubPopper = noop;

			const unsubDerived = effect(
				[rootOpen, rootActiveTrigger, rootOptions],
				([$rootOpen, $rootActiveTrigger, $rootOptions]) => {
					unsubPopper();
					if ($rootOpen && $rootActiveTrigger) {
						tick().then(() => {
							setMeltMenuAttribute(node);
							const popper = usePopper(node, {
								anchorElement: $rootActiveTrigger,
								open: rootOpen,
								options: {
									floating: $rootOptions.positioning,
								},
							});

							if (popper && popper.destroy) {
								unsubPopper = popper.destroy;
							}
						});
					}
				}
			);

			const unsubEvents = executeCallbacks(
				addEventListener(node, 'keydown', (e) => {
					// submenu key events bubble through portals
					// we only care about key events that happen inside this menu
					const target = e.target;
					if (!isHTMLElement(target)) return;

					const menuElement = e.currentTarget;
					if (!isHTMLElement(menuElement)) return;

					const isKeyDownInside = target.closest('[data-melt-menu]') === menuElement;
					if (!isKeyDownInside) return;
					if (FIRST_LAST_KEYS.includes(e.key)) {
						handleMenuNavigation(e);
					}

					// menus should not be navigated using tab so we prevent it
					// reference: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_general_within
					if (e.key === kbd.TAB) {
						e.preventDefault();
						return;
					}

					const isCharacterKey = e.key.length === 1;
					const isModifierKey = e.ctrlKey || e.altKey || e.metaKey;

					if (!isModifierKey && isCharacterKey) {
						// typeahead logic
						handleTypeaheadSearch(e.key, getMenuItems(menuElement));
					}
				})
			);
			return {
				destroy() {
					unsubDerived();
					unsubEvents();
					unsubPopper();
				},
			};
		},
	};

	const rootTrigger = {
		...derived([rootOpen], ([$rootOpen]) => {
			return {
				'aria-controls': rootIds.menu,
				'aria-expanded': $rootOpen,
				'data-state': $rootOpen ? 'open' : 'closed',
				id: rootIds.trigger,
				'data-melt-id': rootIds.trigger,
				'data-melt-part': 'trigger-root',
			} as const;
		}),
		action: (node: HTMLElement) => {
			applyAttrsIfDisabled(node);
			const unsub = executeCallbacks(
				addEventListener(node, 'pointerdown', (e) => {
					const $rootOpen = get(rootOpen);
					const triggerElement = e.currentTarget;
					if (!isHTMLElement(triggerElement)) return;

					const triggerControls = triggerElement.getAttribute('aria-controls');
					if (!triggerControls) return;

					rootOpen.update((prev) => {
						const isOpen = !prev;
						if (isOpen) {
							rootActiveTrigger.set(triggerElement);
						} else {
							rootActiveTrigger.set(null);
						}

						return isOpen;
					});
					if (!$rootOpen) e.preventDefault();
				}),
				addEventListener(node, 'keydown', (e) => {
					const triggerElement = e.currentTarget;
					if (!isHTMLElement(triggerElement)) return;

					if (SELECTION_KEYS.includes(e.key) || e.key === kbd.ARROW_DOWN) {
						rootOpen.update((prev) => {
							const isOpen = !prev;
							if (isOpen) {
								rootActiveTrigger.set(triggerElement);
							} else {
								rootActiveTrigger.set(null);
							}

							return isOpen;
						});

						const menuId = triggerElement.getAttribute('aria-controls');
						if (!menuId) return;

						const menu = document.getElementById(menuId);
						if (!isHTMLElement(menu)) return;

						const menuItems = getMenuItems(menu);
						if (!menuItems.length) return;

						const nextFocusedElement = menuItems[0];
						if (!isHTMLElement(nextFocusedElement)) return;

						handleRovingFocus(nextFocusedElement);
					}

					e.preventDefault();
				})
			);

			return {
				destroy: unsub,
			};
		},
	};

	const rootArrow = derived(rootOptions, ($rootOptions) => ({
		'data-arrow': true,
		'data-melt-part': 'arrow',
		style: styleToString({
			position: 'absolute',
			width: `var(--arrow-size, ${$rootOptions.arrowSize}px)`,
			height: `var(--arrow-size, ${$rootOptions.arrowSize}px)`,
		}),
	}));

	const item = hiddenAction({
		role: 'menuitem',
		tabindex: -1,
		'data-orientation': 'vertical',
		'data-melt-part': 'item',
		action: (node: HTMLElement) => {
			setMeltMenuAttribute(node);
			applyAttrsIfDisabled(node);

			const unsub = executeCallbacks(
				addEventListener(node, 'pointerdown', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					if (isElementDisabled(itemElement)) {
						e.preventDefault();
						return;
					}
				}),
				addEventListener(node, 'click', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					if (isElementDisabled(itemElement)) {
						e.preventDefault();
						return;
					}

					if (e.defaultPrevented) {
						if (!isHTMLElement(itemElement)) return;

						handleRovingFocus(itemElement);
						return;
					}
					itemElement.dispatchEvent(new CustomEvent('m-select', { bubbles: false }));
					rootOpen.set(false);
				}),
				addEventListener(node, 'keydown', (e) => {
					const isTypingAhead = typed.length > 0;
					if (isTypingAhead && e.key === kbd.SPACE) return;
					if (SELECTION_KEYS.includes(e.key)) {
						const itemElement = e.currentTarget;
						if (!isHTMLElement(itemElement)) return;

						itemElement.click();
						/**
						 * We prevent default browser behaviour for selection keys as they should trigger
						 * a selection only:
						 * - prevents space from scrolling the page.
						 * - if keydown causes focus to move, prevents keydown from firing on the new target.
						 */
						e.preventDefault();
					}
				}),
				addEventListener(node, 'pointermove', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;

					if (isElementDisabled(itemElement)) {
						onItemLeave(e);
						return;
					}

					onMenuItemPointerMove(e);
				}),
				addEventListener(node, 'pointerleave', (e) => {
					onMenuItemPointerLeave(e);
				}),
				addEventListener(node, 'focusin', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					itemElement.setAttribute('data-highlighted', '');
				}),
				addEventListener(node, 'focusout', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					itemElement.removeAttribute('data-highlighted');
				})
			);

			return {
				destroy: unsub,
			};
		},
	});

	type CheckboxItemArgs = {
		checked: Writable<boolean | 'indeterminate'>;
	};

	const checkboxItemDefaults = {
		checked: writable(false),
	};

	const checkboxItem = hiddenAction({
		role: 'menuitemcheckbox',
		tabindex: -1,
		'data-orientation': 'vertical',
		'data-melt-part': 'item',
		action: (node: HTMLElement, params: CheckboxItemArgs) => {
			setMeltMenuAttribute(node);
			applyAttrsIfDisabled(node);
			const { checked } = { ...checkboxItemDefaults, ...params };
			const $checked = get(checked) as boolean | 'indeterminate';
			node.setAttribute('aria-checked', isIndeterminate($checked) ? 'mixed' : String($checked));
			node.setAttribute('data-state', getCheckedState($checked));

			const unsub = executeCallbacks(
				addEventListener(node, 'pointerdown', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					if (isElementDisabled(itemElement)) {
						e.preventDefault();
						return;
					}
				}),
				addEventListener(node, 'click', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					if (isElementDisabled(itemElement)) {
						e.preventDefault();
						return;
					}

					if (e.defaultPrevented) {
						if (!isHTMLElement(itemElement)) return;

						handleRovingFocus(itemElement);
						return;
					}
					checked.update((prev) => {
						if (isIndeterminate(prev)) return true;
						return !prev;
					});

					itemElement.dispatchEvent(new CustomEvent('m-select', { bubbles: false }));
					rootOpen.set(false);
				}),
				addEventListener(node, 'keydown', (e) => {
					const isTypingAhead = typed.length > 0;
					if (isTypingAhead && e.key === kbd.SPACE) return;
					if (SELECTION_KEYS.includes(e.key)) {
						const itemElement = e.currentTarget;
						if (!isHTMLElement(itemElement)) return;

						itemElement.click();
						/**
						 * We prevent default browser behaviour for selection keys as they should trigger
						 * a selection only:
						 * - prevents space from scrolling the page.
						 * - if keydown causes focus to move, prevents keydown from firing on the new target.
						 */
						e.preventDefault();
					}
				}),
				addEventListener(node, 'pointermove', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;

					if (isElementDisabled(itemElement)) {
						onItemLeave(e);
						return;
					}

					onMenuItemPointerMove(e);
				}),
				addEventListener(node, 'pointerleave', (e) => {
					onMenuItemPointerLeave(e);
				}),
				addEventListener(node, 'focusin', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					itemElement.setAttribute('data-highlighted', '');
				}),
				addEventListener(node, 'focusout', (e) => {
					const itemElement = e.currentTarget;
					if (!isHTMLElement(itemElement)) return;
					itemElement.removeAttribute('data-highlighted');
				})
			);

			return {
				destroy: unsub,
			};
		},
	});

	/* -------------------------------------------------------------------------------------------------
	 * SUBMENU
	 * -----------------------------------------------------------------------------------------------*/

	const subMenuDefaults = {
		...defaults,
		positioning: {
			placement: 'right-start',
			gutter: 8,
		},
	} satisfies Defaults<CreateDropdownMenuArgs>;

	const createSubMenu = (args?: CreateDropdownMenuArgs) => {
		const withDefaults = { ...subMenuDefaults, ...args } as CreateDropdownMenuArgs;
		const subOptions = writable(withDefaults);

		const subOpen = writable(false);
		const subActiveTrigger = writable<HTMLElement | null>(null);
		const subOpenTimer = writable<number | null>(null);
		const pointerGraceTimer = writable(0);

		const subIds = {
			menu: generateId(),
			trigger: generateId(),
		};

		const subMenu = {
			...derived([subOpen], ([$subOpen]) => {
				return {
					role: 'menu',
					hidden: $subOpen ? undefined : true,
					style: styleToString({
						display: $subOpen ? undefined : 'none',
					}),
					id: subIds.menu,
					'aria-labelledby': subIds.trigger,
					'data-melt-part': 'menu-sub',
					'data-melt-menu': '',
					'data-melt-id': subIds.menu,
					tabindex: -1,
				} as const;
			}),
			action: (node: HTMLElement) => {
				let unsubPopper = noop;

				const unsubDerived = effect(
					[subOpen, subActiveTrigger, subOptions],
					([$subOpen, $subActiveTrigger, $subOptions]) => {
						unsubPopper();
						if ($subOpen && $subActiveTrigger) {
							tick().then(() => {
								const parentMenuEl = getParentMenu($subActiveTrigger);

								const popper = usePopper(node, {
									anchorElement: $subActiveTrigger,
									open: subOpen,
									options: {
										floating: $subOptions.positioning,
										portal: isHTMLElement(parentMenuEl) ? parentMenuEl : undefined,
										clickOutside: null,
										focusTrap: null,
									},
								});

								if (popper && popper.destroy) {
									unsubPopper = popper.destroy;
								}
							});
						}
					}
				);

				const unsubEvents = executeCallbacks(
					addEventListener(node, 'keydown', (e) => {
						if (e.key === kbd.ESCAPE) {
							return;
						}

						// Submenu key events bubble through portals.
						// We only want the keys in this menu.
						const target = e.target;
						if (!isHTMLElement(target)) return;

						const menuElement = e.currentTarget;
						if (!isHTMLElement(menuElement)) return;

						const targetMeltMenuId = target.getAttribute('data-melt-menu-id');
						if (!targetMeltMenuId) return;

						const isKeyDownInside =
							target.closest('[data-melt-menu]') === menuElement &&
							targetMeltMenuId === menuElement.id;

						if (!isKeyDownInside) return;

						if (FIRST_LAST_KEYS.includes(e.key)) {
							// prevent events from bubbling
							e.stopImmediatePropagation();
							handleMenuNavigation(e);
							return;
						}

						const isCloseKey = SUB_CLOSE_KEYS['ltr'].includes(e.key);
						const isModifierKey = e.ctrlKey || e.altKey || e.metaKey;
						const isCharacterKey = e.key.length === 1;

						// close the submenu if the user presses a close key
						if (isCloseKey) {
							const $subActiveTrigger = get(subActiveTrigger);
							e.preventDefault();
							subOpen.update(() => {
								if ($subActiveTrigger) {
									handleRovingFocus($subActiveTrigger);
								}
								subActiveTrigger.set(null);
								return false;
							});
							return;
						}

						// menus should not be navigated using tab so we prevent it
						// reference: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_general_within
						if (e.key === kbd.TAB) {
							e.preventDefault();
							return;
						}

						if (!isModifierKey && isCharacterKey) {
							// typeahead logic
							handleTypeaheadSearch(e.key, getMenuItems(menuElement));
						}
					}),
					addEventListener(node, 'pointermove', (e) => {
						onMenuPointerMove(e);
					}),
					addEventListener(node, 'focusout', (e) => {
						const $subActiveTrigger = get(subActiveTrigger);
						if (get(isUsingKeyboard)) {
							const target = e.target;
							if (!isHTMLElement(target)) return;

							const submenuElement = document.getElementById(subIds.menu);
							if (!isHTMLElement(submenuElement)) return;

							if (!submenuElement?.contains(target) && target !== $subActiveTrigger) {
								subOpen.set(false);
								subActiveTrigger.set(null);
							}
						} else {
							const menuElement = e.currentTarget;
							if (!isHTMLElement(menuElement)) return;

							const relatedTarget = e.relatedTarget;
							if (!isHTMLElement(relatedTarget)) return;

							if (!menuElement.contains(relatedTarget) && relatedTarget !== $subActiveTrigger) {
								subOpen.set(false);
								subActiveTrigger.set(null);
							}
						}
					})
				);

				return {
					destroy() {
						unsubDerived();
						unsubPopper();
						unsubEvents();
					},
				};
			},
		};

		const subTrigger = {
			...derived([subOpen, subOptions], ([$subOpen, $subOptions]) => {
				return {
					role: 'menuitem',
					id: subIds.trigger,
					tabindex: -1,
					'aria-controls': subIds.menu,
					'aria-expanded': $subOpen,
					'data-state': $subOpen ? 'open' : 'closed',
					'data-disabled': $subOptions.disabled ? '' : undefined,
					'data-melt-part': 'subtrigger',
					'aria-haspopop': 'menu',
					'data-melt-id': subIds.trigger,
				} as const;
			}),
			action: (node: HTMLElement) => {
				setMeltMenuAttribute(node);
				applyAttrsIfDisabled(node);

				const unsubTimer = () => {
					clearOpenTimer(subOpenTimer);
					window.clearTimeout(get(pointerGraceTimer));
					pointerGraceIntent.set(null);
				};

				const unsubEvents = executeCallbacks(
					addEventListener(node, 'click', (e) => {
						const triggerElement = e.currentTarget;
						if (!isHTMLElement(triggerElement)) return;
						if (isElementDisabled(triggerElement) || e.defaultPrevented) return;

						// Manually focus because iOS Safari doesn't always focus on click (e.g. buttons)
						handleRovingFocus(triggerElement);
						if (!get(subOpen)) {
							subOpen.update((prev) => {
								const isAlreadyOpen = prev;
								if (!isAlreadyOpen) {
									subActiveTrigger.set(triggerElement);
									return !prev;
								}
								return prev;
							});
						}
					}),
					addEventListener(node, 'keydown', (e) => {
						const triggerElement = e.currentTarget;
						if (!isHTMLElement(triggerElement)) return;
						if (isElementDisabled(triggerElement)) return;
						const isTypingAhead = typed.length > 0;
						if (isTypingAhead && e.key === kbd.SPACE) return;

						if (SUB_OPEN_KEYS['ltr'].includes(e.key)) {
							if (!get(subOpen)) {
								triggerElement.click();
								e.preventDefault();
								return;
							}

							const menuId = triggerElement.getAttribute('aria-controls');
							if (!menuId) return;

							const menuElement = document.getElementById(menuId);
							if (!isHTMLElement(menuElement)) return;

							const firstItem = getMenuItems(menuElement)[0];
							if (!isHTMLElement(firstItem)) return;

							handleRovingFocus(firstItem);
						}
					}),
					addEventListener(node, 'pointermove', (e) => {
						if (!isMouse(e)) return;
						onItemEnter(e);

						if (e.defaultPrevented) return;

						const triggerElement = e.currentTarget;
						if (!isHTMLElement(triggerElement)) return;

						handleRovingFocus(triggerElement);

						const openTimer = get(subOpenTimer);
						if (!get(subOpen) && !openTimer && !isElementDisabled(triggerElement)) {
							subOpenTimer.set(
								window.setTimeout(() => {
									subOpen.update(() => {
										subActiveTrigger.set(triggerElement);
										return true;
									});
									clearOpenTimer(subOpenTimer);
								}, 100)
							);
						}
					}),
					addEventListener(node, 'pointerleave', (e) => {
						if (!isMouse(e)) return;
						clearOpenTimer(subOpenTimer);

						const submenuElement = document.getElementById(subIds.menu);
						const contentRect = submenuElement?.getBoundingClientRect();

						if (contentRect) {
							const side = submenuElement?.dataset.side as Side;
							const rightSide = side === 'right';
							const bleed = rightSide ? -5 : +5;
							const contentNearEdge = contentRect[rightSide ? 'left' : 'right'];
							const contentFarEdge = contentRect[rightSide ? 'right' : 'left'];

							pointerGraceIntent.set({
								area: [
									// Apply a bleed on clientX to ensure that our exit point is
									// consistently within polygon bounds
									{ x: e.clientX + bleed, y: e.clientY },
									{ x: contentNearEdge, y: contentRect.top },
									{ x: contentFarEdge, y: contentRect.top },
									{ x: contentFarEdge, y: contentRect.bottom },
									{ x: contentNearEdge, y: contentRect.bottom },
								],
								side,
							});

							window.clearTimeout(get(pointerGraceTimer));
							pointerGraceTimer.set(
								window.setTimeout(() => {
									pointerGraceIntent.set(null);
								}, 300)
							);
						} else {
							onTriggerLeave(e);
							if (e.defaultPrevented) return;

							// There's 100ms where the user may leave an item before the submenu was opened.
							pointerGraceIntent.set(null);
						}
					}),
					addEventListener(node, 'focusout', (e) => {
						const triggerElement = e.currentTarget;
						if (!isHTMLElement(triggerElement)) return;

						if (!isHTMLElement(triggerElement)) return;
						triggerElement.removeAttribute('data-highlighted');

						const relatedTarget = e.relatedTarget;
						if (!isHTMLElement(relatedTarget)) return;

						const menuId = triggerElement.getAttribute('aria-controls');
						if (!menuId) return;

						const menu = document.getElementById(menuId);

						if (isHTMLElement(menu) && !menu.contains(relatedTarget)) {
							subActiveTrigger.set(null);
							subOpen.set(false);
						}
					}),
					addEventListener(node, 'focusin', (e) => {
						const triggerElement = e.currentTarget;
						if (!isHTMLElement(triggerElement)) return;
						triggerElement.setAttribute('data-highlighted', '');
					})
				);

				return {
					destroy() {
						unsubTimer();
						unsubEvents();
					},
				};
			},
		};

		const subArrow = derived(subOptions, ($subOptions) => ({
			'data-arrow': true,
			style: styleToString({
				position: 'absolute',
				width: `var(--arrow-size, ${$subOptions.arrowSize}px)`,
				height: `var(--arrow-size, ${$subOptions.arrowSize}px)`,
			}),
		}));

		/* -------------------------------------------------------------------------------------------------
		 * Sub Menu Effects
		 * -----------------------------------------------------------------------------------------------*/

		effect([rootOpen], ([$rootOpen]) => {
			if (!$rootOpen) {
				subActiveTrigger.set(null);
				subOpen.set(false);
			}
		});

		effect([pointerGraceIntent], ([$pointerGraceIntent]) => {
			if (!isBrowser) return;
			if (!$pointerGraceIntent) {
				window.clearTimeout(get(pointerGraceTimer));
			}
		});

		effect([subOpen], ([$subOpen]) => {
			if (!isBrowser) return;

			sleep(1).then(() => {
				const menuElement = document.getElementById(subIds.menu);
				if (isHTMLElement(menuElement) && $subOpen && get(isUsingKeyboard)) {
					// Selector to get menu items belonging to menu
					const rootMenuItemSelector = `[role="menuitem"][data-melt-menu-id="${menuElement.id}"]`;

					// Focus on first menu item
					const firstOption = document.querySelector(rootMenuItemSelector);

					if (get(isUsingKeyboard)) {
						isHTMLElement(firstOption) ? handleRovingFocus(firstOption) : undefined;
					}
				}
			});
		});

		return {
			subTrigger,
			subMenu,
			subOpen,
			subArrow,
			subOptions,
		};
	};

	/* -------------------------------------------------------------------------------------------------
	 * Root Effects
	 * -----------------------------------------------------------------------------------------------*/

	effect([rootOpen], ([$rootOpen]) => {
		if (!isBrowser) return;

		sleep(1).then(() => {
			const menuElement = document.getElementById(rootIds.menu);
			if (isHTMLElement(menuElement) && $rootOpen && get(isUsingKeyboard)) {
				// Selector to get menu items belonging to menu
				const rootMenuItemSelector = `[role="menuitem"][data-melt-menu-id="${menuElement.id}"]`;

				// Focus on first menu item
				const firstOption = document.querySelector(rootMenuItemSelector);

				if (get(isUsingKeyboard)) {
					isHTMLElement(firstOption) ? handleRovingFocus(firstOption) : undefined;
				}
			} else {
				// Focus on trigger
				const triggerElement = document.getElementById(rootIds.trigger);
				if (isHTMLElement(triggerElement)) {
					handleRovingFocus(triggerElement);
				}
			}
		});
	});

	onMount(() => {
		const handlePointer = () => isUsingKeyboard.set(false);
		const handleKeyDown = () => {
			isUsingKeyboard.set(true);
			document.addEventListener('pointerdown', handlePointer, { capture: true, once: true });
			document.addEventListener('pointermove', handlePointer, { capture: true, once: true });
		};
		document.addEventListener('keydown', handleKeyDown, { capture: true });

		const keydownListener = (e: KeyboardEvent) => {
			if (e.key === kbd.ESCAPE) {
				rootOpen.set(false);
				return;
			}
		};
		document.addEventListener('keydown', keydownListener);

		return () => {
			document.removeEventListener('keydown', handleKeyDown, { capture: true });
			document.removeEventListener('pointerdown', handlePointer, { capture: true });
			document.removeEventListener('pointermove', handlePointer, { capture: true });
			document.removeEventListener('keydown', keydownListener);
		};
	});

	/* -------------------------------------------------------------------------------------------------
	 * Pointer Event Effects
	 * -----------------------------------------------------------------------------------------------*/

	function onItemEnter(e: PointerEvent) {
		if (isPointerMovingToSubmenu(e)) {
			e.preventDefault();
		}
	}

	function onItemLeave(e: PointerEvent) {
		if (isPointerMovingToSubmenu(e)) {
			return;
		}
		const target = e.target;
		if (!isHTMLElement(target)) return;

		const parentMenuElement = getParentMenu(target);
		if (!isHTMLElement(parentMenuElement)) return;

		handleRovingFocus(parentMenuElement);
	}

	function onTriggerLeave(e: PointerEvent) {
		if (isPointerMovingToSubmenu(e)) {
			e.preventDefault();
		}
	}

	function onMenuPointerMove(e: PointerEvent) {
		if (!isMouse(e)) return;

		const target = e.target;
		if (!isHTMLElement(target)) return;

		const currentTarget = e.currentTarget;
		if (!isHTMLElement(currentTarget)) return;

		const $lastPointerX = get(lastPointerX);
		const pointerXHasChanged = $lastPointerX !== e.clientX;

		// We don't use `e.movementX` for this check because Safari will
		// always return `0` on a pointer e.
		if (currentTarget.contains(target) && pointerXHasChanged) {
			const newDir = e.clientX > $lastPointerX ? 'right' : 'left';
			pointerDir.set(newDir);
			lastPointerX.set(e.clientX);
		}
	}

	function onMenuItemPointerMove(e: PointerEvent) {
		if (!isMouse(e)) return;
		onItemEnter(e);
		if (!e.defaultPrevented) {
			const currentTarget = e.currentTarget;
			if (!isHTMLElement(currentTarget)) return;
			// focus on the current menu item
			handleRovingFocus(currentTarget);
		}
	}

	function onMenuItemPointerLeave(e: PointerEvent) {
		if (!isMouse(e)) return;
		onItemLeave(e);
	}

	/* -------------------------------------------------------------------------------------------------
	 * Helper Functions
	 * -----------------------------------------------------------------------------------------------*/

	function isIndeterminate(checked?: boolean | 'indeterminate'): checked is 'indeterminate' {
		return checked === 'indeterminate';
	}

	function getCheckedState(checked: boolean | 'indeterminate') {
		return isIndeterminate(checked) ? 'indeterminate' : checked ? 'checked' : 'unchecked';
	}

	function applyAttrsIfDisabled(element: HTMLElement | null) {
		if (!isBrowser) return;
		if (!isHTMLElement(element)) return;
		if (isElementDisabled(element)) {
			element.setAttribute('data-disabled', '');
			element.setAttribute('aria-disabled', 'true');
		}
	}

	/**
	 * Manage roving focus between elements. Sets the current active element to
	 * tabindex -1 and the next element to tabindex 0.
	 *
	 * @param nextElement The element to focus on
	 */
	function handleRovingFocus(nextElement: HTMLElement) {
		if (!isBrowser) return;

		const currentFocusedElement = document.activeElement;
		if (!isHTMLElement(currentFocusedElement)) return;

		// if we already have focus on the next element, do nothing
		if (currentFocusedElement === nextElement) return;

		currentFocusedElement.tabIndex = -1;

		nextElement.tabIndex = 0;
		sleep(1).then(() => nextElement.focus());
	}

	function isPointerMovingToSubmenu(e: PointerEvent) {
		return get(pointerMovingToSubmenu)(e);
	}

	/**
	 * Check if the event is a mouse event
	 * @param e The pointer event
	 */
	function isMouse(e: PointerEvent) {
		return e.pointerType === 'mouse';
	}

	/**
	 * Given a timer store, clear the timeout and set the store to null
	 * @param openTimer The timer store
	 */
	function clearOpenTimer(openTimer: Writable<number | null>) {
		if (!isBrowser) return;
		const timer = get(openTimer);
		if (timer) {
			window.clearTimeout(timer);
			openTimer.set(null);
		}
	}

	/**
	 * Keyboard event handler for menu navigation
	 * @param e The keyboard event
	 */
	function handleMenuNavigation(e: KeyboardEvent) {
		e.preventDefault();

		// currently focused menu item
		const currentFocusedItem = document.activeElement;
		if (!isHTMLElement(currentFocusedItem)) return;

		// menu element being navigated
		const currentTarget = e.currentTarget;
		if (!isHTMLElement(currentTarget)) return;

		// menu items of the current menu
		const menuItems = getMenuItems(currentTarget);
		if (!menuItems.length) return;

		const candidateNodes = menuItems.filter((item) => {
			if (item.hasAttribute('data-disabled')) {
				return false;
			}
			if (item.getAttribute('disabled') === 'true') {
				return false;
			}
			return true;
		});

		// Index of the currently focused item in the candidate nodes array
		const currentIndex = candidateNodes.indexOf(currentFocusedItem);

		// Calculate the index of the next menu item
		let nextIndex: number;
		switch (e.key) {
			case kbd.ARROW_DOWN:
				nextIndex = currentIndex < candidateNodes.length - 1 ? currentIndex + 1 : currentIndex;
				break;
			case kbd.ARROW_UP:
				nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
				break;
			case kbd.HOME:
				nextIndex = 0;
				break;
			case kbd.END:
				nextIndex = candidateNodes.length - 1;
				break;
			default:
				return;
		}

		const nextFocusedItem = candidateNodes[nextIndex];

		handleRovingFocus(nextFocusedItem);
	}

	/**
	 * Get the parent menu element for a menu item.
	 * @param element The menu item element
	 */
	function getParentMenu(element: HTMLElement) {
		return element.closest('[role="menu"]');
	}

	/**
	 * Set the `data-melt-menu-id` attribute on a menu item element.
	 * @param element The menu item element
	 */
	function setMeltMenuAttribute(element: HTMLElement | null) {
		if (!element) return;
		const menuEl = element.closest('[data-melt-part="menu-root"], [data-melt-part="menu-sub"]');

		if (!isHTMLElement(menuEl)) return;
		element.setAttribute('data-melt-menu-id', menuEl.id);
	}

	/**
	 * Get the menu items for a given menu element.
	 * This only selects menu items that are direct children of the menu element,
	 * not menu items that are nested in submenus.
	 * @param element The menu item element
	 */
	function getMenuItems(menuElement: HTMLElement) {
		return Array.from(
			menuElement.querySelectorAll(`[data-melt-menu-id="${menuElement.id}"]`)
		) as HTMLElement[];
	}

	return {
		trigger: rootTrigger,
		menu: rootMenu,
		open: rootOpen,
		item,
		checkboxItem,
		arrow: rootArrow,
		options: rootOptions,
		createSubMenu,
	};
}

type Point = { x: number; y: number };
type Polygon = Point[];
type Side = 'left' | 'right';
type GraceIntent = { area: Polygon; side: Side };

// Determine if a point is inside of a polygon.
// Based on https://github.com/substack/point-in-polygon
function isPointInPolygon(point: Point, polygon: Polygon) {
	const { x, y } = point;
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;

		// prettier-ignore
		const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
		if (intersect) inside = !inside;
	}

	return inside;
}

function isPointerInGraceArea(e: PointerEvent, area?: Polygon) {
	if (!area) return false;
	const cursorPos = { x: e.clientX, y: e.clientY };
	return isPointInPolygon(cursorPos, area);
}
