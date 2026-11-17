/** run.mjs 已隔离 HOME；本文件不接触真实配置或数据库。 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import vm from 'node:vm';

export async function testAlerts(ok) {
  console.log('\n[告警] 校验 / 求值 / 配置 API');
  const { defaultAlertsConfig, validateAlertsConfig, evaluateAlerts, loadAlertsConfig } = await import('../src/alerts.js');
  const { DATA_DIR } = await import('../src/config.js');
  assert.ok(DATA_DIR.startsWith(process.env.HOME));
  const check = (name, fn) => { try { fn(); ok(name, true); } catch (err) { ok(name, false, err.message); } };
  const defaults = defaultAlertsConfig();
  const cfg = r => ({ version: 1, rules: [{ ...defaults.rules[0], ...r }] });
  check('默认值保持菜单栏 80/95、10/2，其余禁用', () => {
    assert.deepEqual(defaults.rules.map(r => [r.enabled, r.warn, r.crit]), [[true, 80, 95], [true, 10, 2], [false, null, null], [false, null, null]]);
    assert.deepEqual(validateAlertsConfig(defaults), []);
  });
  for (const [name, config] of [
    ['version', { ...defaults, version: 2 }], ['rules 类型', { version: 1, rules: {} }],
    ['未知指标', cfg({ metric: 'no' })], ['重复 id', { version: 1, rules: [defaults.rules[0], defaults.rules[0]] }],
    ['启用空阈值', cfg({ warn: null, crit: null })], ['字符串阈值', cfg({ warn: '80' })],
    ['负数', cfg({ warn: -1 })], ['无穷大', cfg({ crit: Infinity })], ['NaN', cfg({ warn: NaN })],
    ['百分比上限', cfg({ crit: 101 })], ['高于方向', cfg({ warn: 96 })],
    ['低于方向', cfg({ metric: 'balance', warn: 1, crit: 2 })], ['enabled 类型', cfg({ enabled: 1 })],
    ['provider 范围', cfg({ provider: 'x' })], ['provider 类型', cfg({ metric: 'balance', provider: 1 })],
    ['缺少 warn', { version: 1, rules: [{ id: 'x', metric: 'balance', enabled: false, crit: null }] }],
    ['坏行', { version: 1, rules: [null, 1] }],
  ]) check(`校验拒绝：${name}`, () => assert.ok(validateAlertsConfig(config).length));
  check('空阈值与相等阈值合法', () => {
    for (const r of [{ warn: null }, { crit: null }, { warn: 95 }, { enabled: false, warn: null, crit: null }]) assert.deepEqual(validateAlertsConfig(cfg(r)), []);
    assert.equal(validateAlertsConfig({ version: 1, rules: [null, null] }).length, 2);
  });
  const codex = n => ({ quota: { codex: { data: { windows: [{ used_percent: 0 }, { used_percent: n }] } } } });
  for (const [value, level] of [[79.9, null], [80, 'warn'], [94.9, 'warn'], [95, 'crit']]) {
    check(`Codex 边界 ${value}`, () => assert.equal(evaluateAlerts(codex(value), defaults)[0]?.level ?? null, level));
  }
  for (const [value, level] of [[10, null], [9.99, 'warn'], [2, 'warn'], [1.99, 'crit']]) {
    check(`余额边界 ${value}`, () => assert.equal(evaluateAlerts({ balances: [{ id: 'a', balance: value }] }, defaults)[0]?.level ?? null, level));
  }
  check('缺失数据、非数值、未激活窗口不告警', () => {
    assert.deepEqual(evaluateAlerts({}, defaults), []);
    assert.deepEqual(evaluateAlerts(codex(null), defaults), []);
    assert.deepEqual(evaluateAlerts({ quota: { claude5h: { active: false, window_tokens: 100 } } }, cfg({ metric: 'claude_5h_tokens' })), []);
  });
  check('平铺配额、今日 tokens、活跃 Claude 窗口', () => {
    assert.equal(evaluateAlerts({ quota: { codex: { data: { used_percent: 80 } } } }, defaults)[0].key, 'codex_quota_pct');
    assert.equal(evaluateAlerts({ totals: { today_tokens: 80 } }, cfg({ metric: 'today_tokens' }))[0].level, 'warn');
    assert.equal(evaluateAlerts({ quota: { claude5h: { active: true, window_tokens: 95 } } }, cfg({ metric: 'claude_5h_tokens' }))[0].level, 'crit');
  });
  check('余额过滤、稳定键、严重优先及重复指标独立键', () => {
    const summary = { ...codex(80), balances: [{ id: 'a', provider: 'P', balance: 1 }, { provider: 'Q', balance: 5 }] };
    const items = evaluateAlerts(summary, defaults);
    assert.equal(items[0].key, 'balance:a');
    assert.ok(items.some(i => i.key === 'balance:Q'));
    for (const provider of ['a', 'P']) assert.equal(evaluateAlerts(summary, cfg({ metric: 'balance', warn: 10, crit: 2, provider })).length, 1);
    assert.equal(evaluateAlerts(summary, cfg({ metric: 'balance', warn: 10, crit: 2, provider: 'missing' })).length, 0);
    const repeated = evaluateAlerts(summary, { version: 1, rules: [defaults.rules[0], { ...defaults.rules[0], id: 'second' }] });
    assert.equal(new Set(repeated.map(i => i.key)).size, 2);
    assert.equal(evaluateAlerts(codex(96), defaults)[0].key, items[1].key);
  });
  check('禁用、单级阈值和规则增删保持条件键稳定', () => {
    assert.deepEqual(evaluateAlerts(codex(99), cfg({ enabled: false })), []);
    assert.equal(evaluateAlerts(codex(99), cfg({ crit: null }))[0].level, 'warn');
    assert.equal(evaluateAlerts(codex(80), cfg({ warn: null })).length, 0);
    const rule = { ...defaults.rules[0], id: 'custom' };
    const alone = evaluateAlerts(codex(99), { version: 1, rules: [rule] });
    const together = evaluateAlerts(codex(99), { version: 1, rules: [rule, defaults.rules[0]] });
    assert.equal(alone[0].key, together[0].key);
  });
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const { esc } = await import('../web/lib/format.js');
  const elements = { 'alerts-banner': {}, 'alerts-rules': {} };
  const context = vm.createContext({ esc, document: { getElementById: id => elements[id] } });
  vm.runInContext(`let lastSummary; let alertConfig; ${app.match(/const qBar = [\s\S]*?\n};/)[0]}
    ${app.match(/function renderAlerts\([\s\S]*?\n}/)[0]}
    ${app.match(/function renderAlertSettings\([\s\S]*?\n}/)[0]}`, context);
  check('网页按配置配色、禁用中性且告警文本转义', () => {
    context.rules = defaults.rules;
    vm.runInContext('lastSummary = { alerts: { rules } }', context);
    assert.ok(vm.runInContext("qBar(80, 'codex_quota_pct')", context).includes('lv-warn'));
    assert.ok(vm.runInContext("qBar(95, 'codex_quota_pct')", context).includes('lv-hot'));
    vm.runInContext('lastSummary.alerts.rules = []', context);
    assert.ok(vm.runInContext("qBar(99, 'codex_quota_pct')", context).includes('lv-neutral'));
    vm.runInContext(`renderAlerts({items:[{title:'<img src=x>',body:'<script>x</script>',level:'crit'}]})`, context);
    assert.ok(!elements['alerts-banner'].innerHTML.includes('<img'));
    assert.ok(elements['alerts-banner'].innerHTML.includes('&lt;script&gt;'));
    vm.runInContext('renderAlerts({items:[]})', context);
    assert.equal(elements['alerts-banner'].hidden, true);
    context.config = cfg({ id: '<img src=x>', provider: '<script>' });
    vm.runInContext('alertConfig = config; renderAlertSettings()', context);
    assert.ok(!elements['alerts-rules'].innerHTML.includes('<script>'));
  });
  const path = join(DATA_DIR, 'alerts.json');
  const missing = await loadAlertsConfig();
  check('无文件回落默认且无错误', () => assert.deepEqual(missing, { config: defaults, config_error: null }));
  await mkdir(DATA_DIR, { recursive: true });
  for (const bad of ['{', JSON.stringify(cfg({ warn: -1 }))]) {
    await writeFile(path, bad);
    const loaded = await loadAlertsConfig();
    check('损坏配置回落且不暴露路径', () => {
      assert.deepEqual(loaded.config, defaults);
      assert.ok(loaded.config_error && !loaded.config_error.includes(DATA_DIR));
    });
  }
  const { startServer } = await import('../src/server.js');
  const { Store } = await import('../src/store.js');
  const store = new Store(join(process.env.HOME, 'alerts-test.db'));
  const scanner = new EventEmitter(); scanner.stats = {};
  const poller = { start() {} };
  const server = await startServer({ store, scanner, port: 0, claudePoller: poller, cursorPoller: poller, zcodePoller: poller });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (method = 'PUT', body = JSON.stringify(defaults), headers = {}) => fetch(base + '/api/alerts/config', {
    method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body }),
  });
  let stream;
  try {
    let res = await request('GET'); let data = await res.json();
    check('GET 返回生效配置、默认配置与回落错误', () => { assert.equal(res.status, 200); assert.deepEqual(data.defaults, defaults); assert.ok(data.config_error); });
    const before = await readFile(path, 'utf8');
    for (const [name, method, body, headers, status] of [
      ['校验', 'PUT', JSON.stringify(cfg({ warn: -1 })), {}, 400], ['坏 JSON', 'PUT', '{', {}, 400],
      ['Content-Type', 'PUT', '{}', { 'Content-Type': 'text/plain' }, 400],
      ['外站 Origin', 'PUT', '{}', { Origin: 'https://evil.test' }, 403],
      ['伪本机 Origin', 'PUT', '{}', { Origin: 'http://localhost.evil.test' }, 403],
      ['null Origin', 'PUT', '{}', { Origin: 'null' }, 403],
      ['方法', 'POST', '{}', {}, 405], ['超限', 'PUT', ' '.repeat(65537), {}, 413],
    ]) {
      const response = await request(method, body, headers);
      check(`API 拒绝 ${name} → ${status}`, () => assert.equal(response.status, status));
      if (status === 400) {
        const error = await response.json();
        check(`${name} 返回 details`, () => assert.ok(Array.isArray(error.details)));
      } else await response.text();
      assert.equal(await readFile(path, 'utf8'), before);
    }
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request(base + '/api/alerts/config', { method: 'PUT', headers: { Host: 'evil.test', 'Content-Type': 'application/json' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    check('外站 Host → 403（原生 HTTP 保留 Host）', () => assert.equal(hostStatus, 403));
    // 不带 Content-Length 的分块上传也必须受限。
    const chunkStatus = await new Promise((resolve, reject) => {
      const req = http.request(base + '/api/alerts/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', reject); req.write(' '.repeat(40000)); req.end(' '.repeat(40000));
    });
    check('分块上传超限 → 413', () => assert.equal(chunkStatus, 413));
    const update = new Promise((resolve, reject) => {
      stream = http.get(base + '/api/stream', r => {
        r.once('data', () => resolve(r));
      }); stream.on('error', reject);
    });
    const streamRes = await update;
    let updates = 0;
    const notified = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE timeout')), 2000);
      streamRes.on('data', chunk => { if (chunk.toString().includes('"type":"update"')) { updates++; clearTimeout(timer); resolve(); } });
    });
    const changed = cfg({ warn: 0, crit: null });
    res = await request('PUT', JSON.stringify(changed), { Origin: 'http://localhost:1234' }); data = await res.json();
    await notified;
    check('PUT 原子保存、清除错误并推一次 SSE', () => { assert.equal(res.status, 200); assert.deepEqual(data.config, changed); assert.equal(data.config_error, null); assert.equal(updates, 1); });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), changed);
    store.saveQuota('codex', Date.now(), { used_percent: 1, window_minutes: 300 });
    const summary = await (await fetch(base + '/api/summary')).json();
    check('summary 使用新规则且返回告警字段', () => { assert.equal(summary.alerts.items[0].level, 'warn'); assert.equal(summary.alerts.items[0].threshold, 0); assert.deepEqual(summary.alerts.rules, changed.rules); });
    for (const Origin of ['http://127.0.0.1:9', 'http://[::1]:9999']) {
      res = await request('PUT', JSON.stringify(defaults), { Origin });
      check(`允许本机 Origin ${Origin}`, () => assert.equal(res.status, 200)); await res.text();
    }
    const exactBody = JSON.stringify(defaults).padEnd(65536, ' ');
    res = await request('PUT', exactBody); await res.text();
    check('恰好 64 KiB 的有效请求允许保存', () => assert.equal(res.status, 200));
    res = await request('PUT'); await res.text();
    check('无 Origin 的本机客户端允许写入', () => assert.equal(res.status, 200));
  } finally {
    stream?.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  }
}
