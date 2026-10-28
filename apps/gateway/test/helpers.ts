import type { Server } from 'node:http';

/**
 * WHATWG 为 `fetch` 维护了一份禁用端口表（如 6000、6665-6669、10080），
 * listen(0) 偶尔会撞上，之后每个请求都以 "bad port" 失败。撞上就换一个端口重试。
 */
const BLOCKED = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export async function listenRandom(server: Server, host = '127.0.0.1', attempts = 8): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!BLOCKED.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(`拿不到 fetch 可用的随机端口（连续 ${attempts} 次落在禁用端口表里）`);
}