export class InputController {
  readonly keys = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  fire = false;
  altFire = false;
  locked = false;
  enabled = false;
  onToggleMap?: () => void;
  onInteract?: () => void;
  onPause?: () => void;
  onScan?: () => void;
  onUnexpectedUnlock?: () => void;
  private intentionalRelease = false;

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.clear);
  }

  async requestLock(): Promise<boolean> {
    if (document.pointerLockElement === this.element) return true;
    try {
      await this.element.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try { await this.element.requestPointerLock(); } catch { return false; }
    }
    return document.pointerLockElement === this.element;
  }

  releaseLock(): void {
    this.intentionalRelease = true;
    if (document.pointerLockElement) document.exitPointerLock();
    window.setTimeout(() => { this.intentionalRelease = false; }, 80);
    this.clear();
  }

  consumeMouse(scale = 1): [number, number] {
    const result: [number, number] = [this.mouseX * scale, this.mouseY * scale];
    this.mouseX = 0;
    this.mouseY = 0;
    return result;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  clear = (): void => {
    this.keys.clear();
    this.mouseX = 0;
    this.mouseY = 0;
    this.fire = false;
    this.altFire = false;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat && ['Tab', 'KeyF', 'KeyV', 'Escape'].includes(event.code)) return;
    if (event.code === 'Tab') { event.preventDefault(); this.onToggleMap?.(); return; }
    if (event.code === 'KeyF') { this.onInteract?.(); return; }
    if (event.code === 'KeyV') { this.onScan?.(); return; }
    if (event.code === 'Escape') { this.onPause?.(); return; }
    if (!this.enabled || !this.locked) return;
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => { this.keys.delete(event.code); };
  private onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.locked) return;
    this.mouseX += event.movementX;
    this.mouseY += event.movementY;
  };
  private onLockChange = (): void => { this.locked = document.pointerLockElement === this.element; if (!this.locked) { this.clear(); if (!this.intentionalRelease && this.enabled) this.onUnexpectedUnlock?.(); } };
  private onMouseDown = (event: MouseEvent): void => { if (!this.enabled || !this.locked) return; if (event.button === 0) this.fire = true; if (event.button === 2) this.altFire = true; };
  private onMouseUp = (event: MouseEvent): void => { if (event.button === 0) this.fire = false; if (event.button === 2) this.altFire = false; };
}
