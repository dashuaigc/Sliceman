// PS 27.9+ may paint native button chrome over CSS. These controls use divs.
export function setButtonDisabled(el, disabled) {
  el.setAttribute('aria-disabled', String(!!disabled));
  el.setAttribute('tabindex', disabled ? '-1' : '0');
}

export function bindCustomButton(el) {
  const disabled = () => el.getAttribute('aria-disabled') === 'true'
    || el.classList.contains('btn-off');
  let spaceDown = false;
  // Bind before feature listeners so disabled controls cannot invoke actions.
  el.addEventListener('click', (e) => {
    if (!disabled()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  const activate = () => {
    if (!disabled()) el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  };
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat || disabled()) return;
    if (e.key === 'Enter') activate();
    else spaceDown = true;
  });
  el.addEventListener('keyup', (e) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    const activateOnRelease = spaceDown;
    spaceDown = false;
    if (activateOnRelease) activate();
  });
  el.addEventListener('blur', () => { spaceDown = false; });
}
