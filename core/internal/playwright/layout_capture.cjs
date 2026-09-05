// Run by the Go core with a JSON request on stdin; never through a command shell.
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { chromium } = require(path.join(request.root, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.launch({
    headless: true,
    ...(request.executable ? { executablePath: request.executable } : {}),
    args: process.platform === 'linux' ? [
      '--disable-dev-shm-usage',
      ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
    ] : [],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: request.spec.width, height: request.spec.height }, deviceScaleFactor: 1,
      ...(request.storageState ? { storageState: request.storageState } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(request.url, { waitUntil: 'load', timeout: 30000 });
    const behavior = [];
    for (const step of request.steps) {
      const locator = page.locator(step.selector);
      switch (step.kind) {
        case 'click': await locator.click(); break;
        case 'fill': await locator.fill(step.value); break;
        case 'select': await locator.selectOption(step.value); break;
        case 'visible': await locator.waitFor({ state: 'visible' }); break;
        case 'hidden': await locator.waitFor({ state: 'hidden' }); break;
        default: throw new Error('Unsupported step kind');
      }
      behavior.push({kind:step.kind, selector:step.selector, completed:true});
    }
    await page.evaluate(() => document.fonts.ready);
    // The measurement code is embedded by the extension, never supplied by the model.
    const measure = new Function('return (' + request.measure + ')')();
    const before = await page.evaluate(measure, request.selectors);
    const first = await page.screenshot();
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = await page.screenshot();
    const after = await page.evaluate(measure, request.selectors);
    fs.writeFileSync(path.join(request.output, 'capture.png'), second);
    fs.writeFileSync(path.join(request.output, 'capture.json'), JSON.stringify({
      dom: after, engine: 'playwright', behavior,
      stable: after.fontsReady && first.equals(second) && JSON.stringify(before) === JSON.stringify(after),
    }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
