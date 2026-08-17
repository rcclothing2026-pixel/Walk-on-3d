/**
 * The brand side panel.
 *
 * Slides in from the right (the natural side in an RTL layout), showing a
 * brand's logo, name, description and shop link. Closes three ways, per the
 * brief: Escape, a click on the backdrop, and any node change.
 *
 * Deliberately plain DOM rather than a framework — one panel with three
 * close paths does not need reactivity.
 */

const FOCUSABLE = 'a[href], button:not([disabled])';

export class BrandPanel {
  #root;
  #backdrop;
  #card;
  #open = false;
  #lastFocused = null;

  constructor(container = document.body) {
    this.#root = document.createElement('div');
    this.#root.className = 'panel-layer';
    this.#root.hidden = true;
    this.#root.innerHTML = `
      <div class="panel-backdrop" data-close></div>
      <aside class="brand-panel" role="dialog" aria-modal="true" aria-labelledby="brand-name" dir="rtl">
        <button class="brand-panel__close" data-close aria-label="بستن">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
        <div class="brand-panel__body">
          <img class="brand-panel__logo" id="brand-logo" alt="" hidden />
          <h2 class="brand-panel__name" id="brand-name"></h2>
          <p class="brand-panel__description" id="brand-description"></p>
          <a class="brand-panel__link" id="brand-link" target="_blank" rel="noopener noreferrer" hidden>
            مشاهده فروشگاه
          </a>
        </div>
      </aside>`;

    container.append(this.#root);
    this.#backdrop = this.#root.querySelector('.panel-backdrop');
    this.#card = this.#root.querySelector('.brand-panel');

    this.#root.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
    });

    // Escape is handled at the document level so it works regardless of focus.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#open) {
        event.preventDefault();
        this.close();
      }
      if (event.key === 'Tab' && this.#open) this.#trapFocus(event);
    });

    void this.#backdrop;
  }

  get isOpen() {
    return this.#open;
  }

  /**
   * @param {object} brand
   * @param {string} brand.name
   * @param {string} [brand.description]
   * @param {string} [brand.logoUrl]  already resolved through IMAGE_BASE_URL
   * @param {string} [brand.url]
   */
  open(brand) {
    const logo = this.#root.querySelector('#brand-logo');
    const link = this.#root.querySelector('#brand-link');

    this.#root.querySelector('#brand-name').textContent = brand.name ?? '';
    this.#root.querySelector('#brand-description').textContent = brand.description ?? '';

    if (brand.logoUrl) {
      logo.src = brand.logoUrl;
      logo.alt = brand.name ?? '';
      logo.hidden = false;
    } else {
      logo.hidden = true;
      logo.removeAttribute('src');
    }

    if (brand.url) {
      link.href = brand.url;
      link.hidden = false;
    } else {
      link.hidden = true;
      link.removeAttribute('href');
    }

    this.#lastFocused = document.activeElement;
    this.#root.hidden = false;
    this.#open = true;

    // Next frame, so the transition has a start state to animate from.
    requestAnimationFrame(() => this.#root.classList.add('is-open'));
    this.#card.querySelector('.brand-panel__close')?.focus();
  }

  close() {
    if (!this.#open) return;

    this.#open = false;
    this.#root.classList.remove('is-open');

    const finish = () => {
      if (!this.#open) this.#root.hidden = true;
    };

    // Respect a reduced-motion preference: hide immediately rather than
    // waiting on a transition that will not fire.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else this.#card.addEventListener('transitionend', finish, { once: true });

    this.#lastFocused?.focus?.();
    this.#lastFocused = null;
  }

  #trapFocus(event) {
    const items = [...this.#card.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden);
    if (!items.length) return;

    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
