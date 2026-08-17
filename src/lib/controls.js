/**
 * Phase 5 — the custom navbar controls.
 *
 * Reset-view and gyroscope are not built-in Photo Sphere Viewer buttons. The
 * gyroscope one normally comes from `@photo-sphere-viewer/gyroscope-plugin`,
 * which is not on the project's approved dependency list, so it is implemented
 * here directly against DeviceOrientationEvent instead. That is a little more
 * code but no new package, and it keeps the iOS permission prompt on an
 * explicit user gesture where it belongs.
 *
 * The gyroscope is off by default, deliberately: turning it on unannounced
 * disorients people who were not expecting the view to follow their phone.
 */

const RESET_ICON = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>`;

const GYRO_ICON = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round">
    <circle cx="12" cy="12" r="9" />
    <ellipse cx="12" cy="12" rx="9" ry="3.8" />
    <path d="M12 3v18" />
  </svg>`;

/**
 * Registers the custom buttons on a viewer.
 *
 * Must be called before `new Viewer(...)`, since the navbar is built from the
 * registry at construction time.
 */
export function registerControls({ onResetLabel = 'بازنشانی دید', onGyroLabel = 'ژیروسکوپ' } = {}) {
  return {
    reset: {
      id: 'tour-reset',
      content: RESET_ICON,
      title: onResetLabel,
      className: 'tour-btn',
      onClick: (viewer) => {
        // Fast enough to feel like a snap-back rather than a slow drift.
        viewer.animate({ yaw: 0, pitch: 0, zoom: 40, speed: '20rpm' });
      },
    },
    gyroscope: {
      id: 'tour-gyro',
      content: GYRO_ICON,
      title: onGyroLabel,
      className: 'tour-btn',
      // Keep it on the bar rather than buried in the overflow menu.
      collapsable: false,
      onClick: (viewer) => viewer.__gyroscope?.toggle(),
    },
  };
}

/**
 * Device-orientation control.
 *
 * Kept as a small class rather than free functions so the listener, the
 * enabled flag and the permission state travel together — a half-torn-down
 * orientation listener quietly fighting the user's drag is a miserable bug.
 */
export class Gyroscope {
  #viewer;
  #enabled = false;
  #onChange;
  #handler = null;

  constructor(viewer, { onChange = null } = {}) {
    this.#viewer = viewer;
    this.#onChange = onChange;
    viewer.__gyroscope = this;
  }

  get enabled() {
    return this.#enabled;
  }

  /** True when the device can report orientation at all. */
  static get supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  async toggle() {
    if (this.#enabled) this.disable();
    else await this.enable();
    return this.#enabled;
  }

  async enable() {
    if (this.#enabled || !Gyroscope.supported) return false;

    // iOS 13+ gates orientation behind a permission prompt that must be
    // requested from a user gesture — which is why this hangs off the button.
    const request = DeviceOrientationEvent.requestPermission;
    if (typeof request === 'function') {
      try {
        if ((await request.call(DeviceOrientationEvent)) !== 'granted') return false;
      } catch {
        return false;
      }
    }

    this.#handler = (event) => this.#apply(event);
    window.addEventListener('deviceorientation', this.#handler, true);
    this.#enabled = true;
    this.#onChange?.(true);
    return true;
  }

  disable() {
    if (!this.#enabled) return;

    window.removeEventListener('deviceorientation', this.#handler, true);
    this.#handler = null;
    this.#enabled = false;
    this.#onChange?.(false);
  }

  /**
   * Maps device orientation onto the sphere.
   *
   * `alpha` is the compass heading and `beta` the front-to-back tilt. Pitch is
   * clamped so that tipping the phone past vertical cannot flip the view over.
   */
  #apply(event) {
    if (event.alpha === null || event.beta === null) return;

    const yaw = deg2rad(-event.alpha);
    const pitch = deg2rad(clamp(event.beta - 90, -85, 85));

    this.#viewer.rotate({ yaw, pitch });
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deg2rad(value) {
  return (value * Math.PI) / 180;
}
