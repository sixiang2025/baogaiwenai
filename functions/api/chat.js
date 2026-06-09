const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 处理 CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// 激活码验证接口
export async function onRequestPost(context) {
  const url = new URL(context.request.url);

  try {
    const body = await context.request.json();
    const action = body.action;

    // ── 激活码验证 ──────────────────────────────
    if (action === 'activate') {
      const code = (body.code || '').trim().toUpperCase();
      if (!code) {
        return json({ success: false, error: '请输入激活码' }, 400);
      }

      // 从 KV 读取激活码信息
      const codeData = await context.env.CODES_KV.get(`code:${code}`);
      if (!codeData) {
        return json({ success: false, error: '激活码无效，请检查后重试' });
      }

      const info = JSON.parse(codeData);

      // 检查是否已被使用
      if (info.used) {
        return json({ success: false, error: '该激活码已被使用' });
      }

      // 标记为已使用，写入初始次数
      await context.env.CODES_KV.put(`code:${code}`, JSON.stringify({
        ...info,
        used: true,
        usedAt: new Date().toISOString(),
      }));

      // 生成一个 session token，存入 KV
      const token = generateToken();
      await context.env.CODES_KV.put(`token:${token}`, JSON.stringify({
        credits: info.credits,
        createdAt: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 365 }); // 1年有效期

      return json({ success: true, token, credits: info.credits });
    }

    // ── 文案生成 ────────────────────────────────
    if (action === 'generate') {
      const token = (body.token || '').trim();
      const { systemPrompt, userPrompt } = body;

      if (!token) return json({ success: false, error: '未激活，请先输入激活码' }, 401);
      if (!systemPrompt || !userPrompt) return json({ success: false, error: '缺少必要参数' }, 400);

      // 验证 token 并检查次数
      const tokenData = await context.env.CODES_KV.get(`token:${token}`);
      if (!tokenData) return json({ success: false, error: '登录已失效，请重新激活' }, 401);

      const session = JSON.parse(tokenData);
      if (session.credits <= 0) {
        return json({ success: false, error: 'CREDITS_EMPTY' });
      }

      // 内容过滤
      const blocked = ['诈骗', '洗钱', '毒品', '赌博', '色情', '违禁'];
      for (const kw of blocked) {
        if (userPrompt.includes(kw)) {
          return json({ success: false, error: '输入内容包含违规关键词，请修改后重试' }, 400);
        }
      }

      // 调用 OpenRouter
      const apiKey = context.env.OPENROUTER_API_KEY;
      if (!apiKey) return json({ success: false, error: '服务配置异常，请联系管理员' }, 500);

      const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://baogaiwenai.pages.dev',
          'X-Title': 'BaoGaiWenAn'
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          stream: false,
          temperature: 0.75
        })
      });

      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        return json({ success: false, error: aiData?.error?.message || 'AI调用失败' }, aiRes.status);
      }

      // 扣减次数
      const newCredits = session.credits - 1;
      await context.env.CODES_KV.put(`token:${token}`, JSON.stringify({
        ...session,
        credits: newCredits,
      }), { expirationTtl: 60 * 60 * 24 * 365 });

      const result = aiData?.choices?.[0]?.message?.content;
      return json({ success: true, result, credits: newCredits });
    }

    // ── 查询剩余次数 ─────────────────────────────
    if (action === 'credits') {
      const token = (body.token || '').trim();
      if (!token) return json({ success: false, error: '未激活' }, 401);

      const tokenData = await context.env.CODES_KV.get(`token:${token}`);
      if (!tokenData) return json({ success: false, error: '登录已失效' }, 401);

      const session = JSON.parse(tokenData);
      return json({ success: true, credits: session.credits });
    }

    return json({ error: '未知操作' }, 400);

  } catch (err) {
    return json({ success: false, error: '服务器异常: ' + err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
