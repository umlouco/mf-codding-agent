(selectors) => {
  const rect = r => ({x:r.x, y:r.y, width:r.width, height:r.height});
  return {
    url: location.href, title: document.title,
    viewport: {width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio},
    scroll: {x: scrollX, y: scrollY}, documentWidth: document.documentElement.scrollWidth,
    fontsReady: !document.fonts || document.fonts.status === 'loaded',
    elements: selectors.map(selector => {
      const nodes = document.querySelectorAll(selector);
      const el = nodes[0];
      if (!el) return {selector, count:0};
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return {selector, count:nodes.length, rect:rect(r),
        visible:s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0,
        text:(el.innerText || '').slice(0,160),
        overflowX:s.overflowX, overflowY:s.overflowY,
        scrollWidth:el.scrollWidth, clientWidth:el.clientWidth};
    })
  };
}
