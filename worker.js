export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname;
    const search = url.search;

    // --- 1. 处理 Webhook (保持不变) ---
    if (request.method === "POST" && pathname === "/update-port") {
      try {
        const { port, secret } = await request.json();
        if (secret !== env.AUTH_SECRET) return new Response("Unauthorized", { status: 401 });
        await env.STUN_HTTPS.put("GLOBAL_V4_PORT", port.toString());
        return new Response("Port Updated");
      } catch (e) { return new Response("Error", { status: 400 }); }
    }

    // --- 2. 获取目标端口 ---
    const clientIP = request.headers.get("cf-connecting-ip") || "";
    const isV6 = clientIP.includes(':'); 
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
    
    // 使用 URL 对象构造确保格式 100% 正确
    const redirectUrl = new URL(`https://${targetHost}:${targetPort}${pathname}${search}`);
    redirectUrl.searchParams.set("ts", Date.now().toString());

    // --- 4. 响应头 (强制不缓存) ---
    const commonHeaders = {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Vary": "cf-connecting-ip",
      "Access-Control-Allow-Origin": "*" // 解决部分应用 API 跨域问题
    };

    // --- 5. 执行跳转 (关键修改) ---
    // 放弃 HTML Meta Refresh，全量改用 307 重定向
    // 307 对 Chromium 最友好，且能完美支持 GET/POST 路径跳转
    return new Response(null, {
      status: 307,
      headers: {
        ...commonHeaders,
        "Location": redirectUrl.href
      }
    });
  }
};