import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAlwaysBlockedIp,
  isBlockedIp,
  resolveOutboundUrl,
  safeFetch,
  type DnsLookup,
  type FetchImplementation,
} from '../src/egress';

const publicDns: DnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

test('egress allows only HTTP(S), rejects credentials and blocks metadata destinations', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'https://user:pass@example.com', 'http://169.254.169.254/latest', 'http://metadata.google.internal/computeMetadata/v1/']) {
    await assert.rejects(resolveOutboundUrl(url, { lookupImpl: publicDns, allowPrivateOrigins: [] }), (err: any) => err.code === 'EGRESS_URL_DENIED', url);
  }
});

test('special IPv4 and IPv6 ranges cannot be bypassed with alternate notation', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '100.100.100.200', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp('93.184.216.34'), false);
  assert.equal(isBlockedIp('2606:2800:220:1:248:1893:25c8:1946'), false);
  assert.equal(isAlwaysBlockedIp('fe80::1'), true);
  assert.equal(isAlwaysBlockedIp('febf::1'), true);
  assert.equal(isAlwaysBlockedIp('240.0.0.1'), true);
  assert.equal(isAlwaysBlockedIp('fd00:ec2::254'), true);
  assert.equal(isAlwaysBlockedIp('::ffff:169.254.169.254'), true);
});

test('every DNS answer is checked and the connection address is pinned', async () => {
  let fetched = false;
  const fetchImpl: FetchImplementation = async () => { fetched = true; return jsonResponse({}); };
  await assert.rejects(safeFetch('https://mixed.example/data', {}, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    fetchImpl,
    allowPrivateOrigins: [],
  }), (err: any) => err.code === 'EGRESS_URL_DENIED');
  assert.equal(fetched, false);

  let pinned = '';
  const pinningFetch: FetchImplementation = async (_url, init) => {
    const dispatcher = init.dispatcher;
    const optionsSymbol = dispatcher && Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === 'options');
    const options = optionsSymbol ? (dispatcher as any)[optionsSymbol] : undefined;
    options?.connect?.lookup('mixed.example', { all: true }, (_err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => {
      const entry = Array.isArray(address) ? address[0] : { address, family: family! };
      pinned = `${entry.address}/${entry.family}`;
    });
    return jsonResponse({ ok: true });
  };
  const response = await safeFetch('https://mixed.example/data', {}, { lookupImpl: publicDns, fetchImpl: pinningFetch, allowPrivateOrigins: [] });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(pinned, '93.184.216.34/4');
});

test('private origins require exact opt-in while link-local remains always blocked', async () => {
  const lookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(resolveOutboundUrl('http://127.0.0.1:8080/admin', { lookupImpl: lookup, allowPrivateOrigins: [] }), (err: any) => err.code === 'EGRESS_URL_DENIED');
  const allowed = await resolveOutboundUrl('http://127.0.0.1:8080/admin', { lookupImpl: lookup, allowPrivateOrigins: ['http://127.0.0.1:8080'] });
  assert.equal(allowed.address, '127.0.0.1');
  await assert.rejects(resolveOutboundUrl('http://127.0.0.1:9090/admin', { lookupImpl: lookup, allowPrivateOrigins: ['http://127.0.0.1:8080'] }), (err: any) => err.code === 'EGRESS_URL_DENIED');
  await assert.rejects(resolveOutboundUrl('http://169.254.169.254/latest', {
    lookupImpl: publicDns,
    allowPrivateOrigins: ['http://169.254.169.254'],
  }), (err: any) => err.code === 'EGRESS_URL_DENIED');
});

test('cross-origin redirects strip credentials and same-origin mode rejects the hop', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: FetchImplementation = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return seen.length === 1
      ? jsonResponse({}, 302, { location: 'https://other.example/next' })
      : jsonResponse({ ok: true });
  };
  const response = await safeFetch('https://trusted.example/start', {
    headers: { authorization: 'Bearer secret', cookie: 'session=secret', 'x-api-key': 'secret', 'proxy-authorization': 'Basic secret', 'x-custom-secret': 'secret', 'content-type': 'application/json', accept: 'application/json' },
  }, { lookupImpl: publicDns, fetchImpl, allowPrivateOrigins: [] });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].headers.get('authorization'), null);
  assert.equal(seen[1].headers.get('cookie'), null);
  assert.equal(seen[1].headers.get('x-api-key'), null);
  assert.equal(seen[1].headers.get('proxy-authorization'), null);
  assert.equal(seen[1].headers.get('x-custom-secret'), null);
  assert.equal(seen[1].headers.get('accept'), 'application/json');

  let calls = 0;
  await assert.rejects(safeFetch('https://trusted.example/start', {}, {
    sameOriginOnly: true,
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => { calls += 1; return jsonResponse({}, 302, { location: 'https://other.example/next' }); },
  }), (err: any) => err.code === 'EGRESS_REDIRECT_DENIED');
  assert.equal(calls, 1);
});

test('response size, total timeout, DNS timeout and redirect count are bounded', async () => {
  await assert.rejects(safeFetch('https://large.example', {}, {
    maxBytes: 4,
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => new Response('123456'),
  }), (err: any) => err.code === 'EGRESS_RESPONSE_TOO_LARGE');

  await assert.rejects(safeFetch('https://slow.example', {}, {
    timeoutMs: 20,
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  }), (err: any) => err.code === 'EGRESS_TIMEOUT');

  await assert.rejects(safeFetch('https://dns-slow.example', {}, {
    timeoutMs: 20,
    lookupImpl: () => new Promise(() => undefined),
    allowPrivateOrigins: [],
    fetchImpl: async () => jsonResponse({}),
  }), (err: any) => err.code === 'EGRESS_TIMEOUT');

  await assert.rejects(safeFetch('https://loop.example', {}, {
    maxRedirects: 1,
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => jsonResponse({}, 302, { location: '/again' }),
  }), (err: any) => err.code === 'EGRESS_REDIRECT_LIMIT');
});

test('all IPv6 transition forms are denied even when they embed a public IPv4 address', async () => {
  const transitions = [
    '::ffff:93.184.216.34', // IPv4-mapped
    '::ffff:0:93.184.216.34', // IPv4-translated
    '::93.184.216.34', // IPv4-compatible
    '64:ff9b::5db8:d822', // Well-known NAT64
    '64:ff9b:1::7f00:1', // Local-use NAT64
    '2002:5db8:d822::', // 6to4
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2606:4700:4700::5efe:5db8:d822', // ISATAP
  ];
  for (const ip of transitions) {
    assert.equal(isBlockedIp(ip), true, ip);
    assert.equal(isAlwaysBlockedIp(ip), true, ip);
    await assert.rejects(resolveOutboundUrl(`http://[${ip}]/`, {
      allowPrivateOrigins: [`http://[${ip}]`],
    }), (err: any) => err.code === 'EGRESS_URL_DENIED', ip);
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isAlwaysBlockedIp('2606:4700:4700::1111'), false);
});

test('caller protocol policy and URL policy apply to every accepted hop', async () => {
  let calls = 0;
  await assert.rejects(safeFetch('http://policy.example/start', {}, {
    allowedProtocols: ['https:'],
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  }), (err: any) => err.code === 'EGRESS_URL_DENIED');
  assert.equal(calls, 0);

  const validated: string[] = [];
  const response = await safeFetch('https://policy.example/start', {}, {
    allowedProtocols: ['https'],
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    validateUrl: (url) => { validated.push(url.toString()); },
    fetchImpl: async () => validated.length === 1
      ? jsonResponse({}, 302, { location: '/next' })
      : jsonResponse({ ok: true }),
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(validated, ['https://policy.example/start', 'https://policy.example/next']);
});

test('a redirect to a private address is rejected before the second request', async () => {
  let calls = 0;
  await assert.rejects(safeFetch('https://public.example/start', {}, {
    lookupImpl: async (host) => [{ address: host === 'public.example' ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    allowPrivateOrigins: [],
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({}, 302, { location: 'https://private.example/secret' });
    },
  }), (err: any) => err.code === 'EGRESS_URL_DENIED');
  assert.equal(calls, 1);
});

test('one total deadline spans redirects and a stalled response body', async () => {
  let calls = 0;
  await assert.rejects(safeFetch('https://slow-redirect.example/start', {}, {
    timeoutMs: 30,
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 302, { location: '/stalled' });
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    },
  }), (err: any) => err.code === 'EGRESS_TIMEOUT');
  assert.equal(calls, 2);
});

test('declared and streamed oversized bodies are rejected', async () => {
  for (const fetchImpl of [
    async () => new Response('12345', { status: 200, headers: { 'content-length': '5' } }),
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); controller.close(); },
    }), { status: 200 }),
  ] satisfies FetchImplementation[]) {
    await assert.rejects(safeFetch('https://large.example/body', {}, {
      maxBytes: 4,
      lookupImpl: publicDns,
      allowPrivateOrigins: [],
      fetchImpl,
    }), (err: any) => err.code === 'EGRESS_RESPONSE_TOO_LARGE');
  }
});

test('proxy transport pins the target IP while preserving Host and TLS SNI', async () => {
  let transportUrl = '';
  let host = '';
  let proxyOptions: any;
  const response = await safeFetch('https://provider.example:8443/v1', {}, {
    proxyUrl: 'http://127.0.0.1:8080',
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async (url, init) => {
      transportUrl = url;
      host = new Headers(init.headers).get('host') ?? '';
      const optionsSymbol = Object.getOwnPropertySymbols(init.dispatcher).find((symbol) => symbol.description === 'proxy agent options');
      const tlsSymbol = Object.getOwnPropertySymbols(init.dispatcher).find((symbol) => symbol.description === 'request tls settings');
      proxyOptions = {
        uri: optionsSymbol ? (init.dispatcher as any)[optionsSymbol]?.uri : undefined,
        requestTls: tlsSymbol ? (init.dispatcher as any)[tlsSymbol] : undefined,
      };
      return jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(transportUrl, 'https://93.184.216.34:8443/v1');
  assert.equal(host, 'provider.example:8443');
  assert.equal(proxyOptions?.uri, 'http://127.0.0.1:8080/');
  assert.equal(proxyOptions?.requestTls?.servername, 'provider.example');
});

test('redirect error mode does not follow a redirect', async () => {
  let calls = 0;
  await assert.rejects(safeFetch('https://no-redirect.example/start', { redirect: 'error' }, {
    lookupImpl: publicDns,
    allowPrivateOrigins: [],
    fetchImpl: async () => { calls += 1; return jsonResponse({}, 302, { location: '/next' }); },
  }), (err: any) => err.code === 'EGRESS_REDIRECT_DENIED');
  assert.equal(calls, 1);
});
