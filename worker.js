export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const hostname = url.hostname.toLowerCase();
      const pathname = url.pathname;
      const search = url.search;

      // 检查必要环境变量
      if (!env.MAIN_DOMAIN_A) return new Response("Missing env: MAIN_DOMAIN_A", { status: 500 });
      if (!env.MAIN_DOMAIN_B) return new Response("Missing env: MAIN_DOMAIN_B", { status: 500 });
      if (!env.DEFAULT_V6_PORT) return new Response("Missing env: DEFAULT_V6_PORT", { status: 500 });
      if (!env.AUTH_SECRET) return new Response("Missing env: AUTH_SECRET", { status: 500 });
      if (!env.STUN_HTTPS) return new Response("Missing KV binding: STUN_HTTPS", { status: 500 });

      // --- 1. 处理 Webhook ---
      if (request.method === "POST" && pathname === "/update-port") {
        try {
          const { port, secret } = await request.json();
          if (secret !== env.AUTH_SECRET) return new Response("Unauthorized", { status: 401 });
          await env.STUN_HTTPS.put("GLOBAL_V4_PORT", port.toString());
          return new Response("Port Updated");
        } catch (e) {
          return new Response("Error", { status: 400 });
        }
      }

      // --- 2. 获取目标端口 ---
      const clientIP = request.headers.get("cf-connecting-ip") || "";
      const isV6 = clientIP.includes(":");
      let targetPort = isV6 ? env.DEFAULT_V6_PORT : await env.STUN_HTTPS.get("GLOBAL_V4_PORT");

      if (!targetPort) {
        return new Response("V4 Port not found. Check Lucky status.", { status: 503 });
      }

      // --- 3. 域名转换逻辑 ---
      const MAIN_DOMAIN_A = env.MAIN_DOMAIN_A;
      const MAIN_DOMAIN_B = env.MAIN_DOMAIN_B;

      let targetHost = MAIN_DOMAIN_B;
      if (hostname !== MAIN_DOMAIN_A && hostname.endsWith(MAIN_DOMAIN_A)) {
        const subdomain = hostname.replace(`.${MAIN_DOMAIN_A}`, "").replace(/^\./, "");
        targetHost = `${subdomain}.${MAIN_DOMAIN_B}`;
      }

      const redirectUrl = new URL(`https://${targetHost}:${targetPort}${pathname}${search}`);

      // --- 4. 响应头 (强制不缓存) ---
      const commonHeaders = {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Vary": "cf-connecting-ip",
        "Access-Control-Allow-Origin": "*",
      };

      // --- 5. 执行跳转 ---
      return new Response(null, {
        status: 307,
        headers: {
          ...commonHeaders,
          "Location": redirectUrl.href,
        },
      });
    } catch (e) {
      return new Response(`Worker Error: ${e.message}`, { status: 500 });
    }
  },
};