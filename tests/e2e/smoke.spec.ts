import { expect, test } from '@playwright/test';

test('boots into cinematic start screen with low-chrome UI', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('ASTRAL FRONTIER')).toBeVisible();
  await expect(page.getByRole('button', { name: /开始探索/ })).toBeVisible();
  await expect(page.locator('canvas.webgl')).toBeVisible();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/hero.png', fullPage: true });
});

test('opens the 512-node navigation surface', async ({ page }) => {
  await page.goto('/?skipIntro=1');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' })));
  await expect(page.locator('[data-ui="map"]')).toHaveClass(/visible/);
  await expect(page.getByText('深空星图')).toBeVisible();
  await expect(page.getByText(/跃迁范围内/)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/starmap.png', fullPage: true });
});

test('renders the fold-space opening without a loading screen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.waitForTimeout(4200);
  await page.screenshot({ path: 'test-results/warp.png', fullPage: true });
});

test('folds into and unfolds from warp without an abrupt scene cut', async ({ page }) => {
  await page.goto('/?scene=warp');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/warp-charge.png', fullPage: true });
  await page.waitForTimeout(1050);
  await page.screenshot({ path: 'test-results/warp-departure.png', fullPage: true });
  await page.goto('/?scene=warp-cruise');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/warp-cruise.png', fullPage: true });
  await page.goto('/?scene=warp-arrival');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/warp-arrival.png', fullPage: true });
  await expect(page.getByText('航道退出')).toBeVisible();
});

test('renders the high-altitude terrain scene', async ({ page }) => {
  await page.goto('/?scene=surface');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText('低空飞行')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/surface.png', fullPage: true });
});

test('shows a planet-scale world and separated atmosphere from far orbit', async ({ page }) => {
  await page.goto('/?skipIntro=1');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText('近轨飞行')).toBeVisible();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'test-results/planet-far.png', fullPage: true });
  const altitude = Number((await page.locator('[data-ui="altitude"]').textContent())?.replace(/,/g, ''));
  expect(altitude).toBeGreaterThan(20);
});

test('keeps atmospheric thickness readable in near orbit', async ({ page }) => {
  await page.goto('/?scene=orbit-near');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText(/外层大气/)).toBeVisible();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'test-results/planet-near.png', fullPage: true });
});

test('crosses the geometric atmosphere without a loading frame', async ({ page }) => {
  test.setTimeout(100_000);
  await page.goto('/?scene=atmosphere');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText('大气层进入')).toBeVisible();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/atmosphere-orbit.png', fullPage: true });
  await page.waitForTimeout(5200);
  await page.screenshot({ path: 'test-results/atmosphere-plasma.png', fullPage: true });
  await page.waitForTimeout(5700);
  await page.screenshot({ path: 'test-results/atmosphere-cloud-deck.png', fullPage: true });
  await page.waitForTimeout(2700);
  await page.screenshot({ path: 'test-results/atmosphere-high.png', fullPage: true });
});

test('shows terrain below the cloud layer during late descent', async ({ page }) => {
  await page.goto('/?scene=atmosphere&phase=.74');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.locator('canvas.webgl')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/atmosphere-terrain-gap.png', fullPage: true });
});

test('renders the first-person exploration scene', async ({ page }) => {
  await page.goto('/?scene=foot');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText('地表勘探')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/foot.png', fullPage: true });
});

test('grounds the abandoned station on its terrain-cut foundation', async ({ page }) => {
  await page.goto('/?scene=station');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText('地表勘探')).toBeVisible();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: 'test-results/station-runtime.png', fullPage: true });
});

test('renders the corrected high-detail sentinel drone', async ({ page }) => {
  await page.goto('/?scene=drone');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText(/摧毁守卫无人机/)).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/drone-runtime.png', fullPage: true });
});

test('boards the landed ship from the deployed side ramp', async ({ page }) => {
  await page.goto('/?scene=foot');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await expect(page.getByText(/通过侧舱门登上 ASTERION S-9/)).toBeVisible();
  await page.keyboard.press('KeyF');
  await expect(page.getByText('着陆锁定')).toBeVisible();
  await expect(page.getByText(/W 起飞或再次离船/)).toBeVisible();
});

test('right mouse button engages ship boost', async ({ page }) => {
  await page.goto('/?skipIntro=1');
  await page.getByRole('button', { name: /开始探索/ }).click();
  const canvas = page.locator('canvas.webgl');
  await canvas.click({ button: 'right' });
  await canvas.hover();
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(900);
  const speed = Number((await page.locator('[data-ui="speed"]').textContent())?.replace(/,/g, ''));
  const boost = Number(await page.locator('.ui-root').evaluate((element) => getComputedStyle(element).getPropertyValue('--boost')));
  await page.screenshot({ path: 'test-results/boost-runtime.png', fullPage: true });
  await page.mouse.up({ button: 'right' });
  expect(speed).toBeGreaterThan(200);
  expect(boost).toBeGreaterThan(.75);
});

test('resumes after pointer unlock and a hidden-tab visibility cycle', async ({ page }) => {
  await page.goto('/?skipIntro=1');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-ui="pause"]')).toHaveClass(/visible/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '返回游戏' }).click();
  await expect(page.locator('[data-ui="pause"]')).not.toHaveClass(/visible/);
  await expect(page.getByText('近轨飞行')).toBeVisible();
  await page.waitForTimeout(350);
  const before = Number((await page.locator('[data-ui="speed"]').textContent())?.replace(/,/g, ''));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(450);
  const after = Number((await page.locator('[data-ui="speed"]').textContent())?.replace(/,/g, ''));
  await page.keyboard.up('KeyW');
  expect(after).toBeGreaterThan(before);
});

test('climbs from the surface back through the atmosphere', async ({ page }) => {
  await page.goto('/?scene=surface-high');
  await page.getByRole('button', { name: /开始探索/ }).click();
  await page.mouse.move(720, 450);
  await page.mouse.move(720, 80, { steps: 8 });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(5200);
  await expect(page.getByText('大气层脱离', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ascent-clouds.png', fullPage: true });
  await page.waitForTimeout(4800);
  await page.screenshot({ path: 'test-results/ascent-orbit.png', fullPage: true });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
});
