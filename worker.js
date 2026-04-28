/**
 * 邮件 AI 智能看板 v8.0 (绝对稳定版)
 * 修复：URL 编码导致的状态卡死、Base64 UTF-8 中文乱码问题
 */

export default {
  // ==========================================
  // 1. 邮件接收端
  // ==========================================
  async email(message, env, ctx) {
    const msgId = message.headers.get("Message-ID") || `id-${Date.now()}`;
    const subject = message.headers.get("subject") || "无主题";
    const from = message.from;

    let index = await env.MAIL_SUMMARY_KV.get("email_index", { type: "json" }) || [];
    if (index.find(e => e.id === msgId)) return;

    const rawContent = await new Response(message.raw).text();
    const cleanBody = extractTextBody(rawContent);

    const newEntry = {
      id: msgId,
      subject,
      from,
      time: new Date().getTime(),
      status: 'processing' 
    };
    
    index.unshift(newEntry);
    
    if (index.length > 500) {
      const removed = index.pop();
      await env.MAIL_SUMMARY_KV.delete(`body_${removed.id}`);
      await env.MAIL_SUMMARY_KV.delete(`summary_${removed.id}`);
    }

    await env.MAIL_SUMMARY_KV.put(`body_${msgId}`, cleanBody);
    await env.MAIL_SUMMARY_KV.put("email_index", JSON.stringify(index));

    ctx.waitUntil(processAI(env, msgId, subject, cleanBody));
  },

  // ==========================================
  // 2. API 接口端 (修复了 URL 编码识别问题)
  // ==========================================
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json;charset=UTF-8"
    };
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // API: 获取列表
    if (path === "/api/emails" && method === "GET") {
      const page = parseInt(url.searchParams.get("page")) || 1;
      const limit = 20;
      let index = await env.MAIL_SUMMARY_KV.get("email_index", { type: "json" }) || [];
      const total = index.length;
      const start = (page - 1) * limit;
      return new Response(JSON.stringify({ total, page, list: index.slice(start, start + limit) }), { headers: corsHeaders });
    }

    // API: 获取详情
    if (path.startsWith("/api/emails/") && method === "GET") {
      // 关键修复 1：解码 URL 中的特殊符号（如尖括号）
      const id = decodeURIComponent(path.split("/").pop());
      let index = await env.MAIL_SUMMARY_KV.get("email_index", { type: "json" }) || [];
      const entry = index.find(e => e.id === id) || {};
      
      const summary = await env.MAIL_SUMMARY_KV.get(`summary_${id}`);
      const body = await env.MAIL_SUMMARY_KV.get(`body_${id}`);
      
      return new Response(JSON.stringify({ 
        status: entry.status || 'unknown',
        summary: summary || '', 
        body: body || '' 
      }), { headers: corsHeaders });
    }

    // API: 手动重试
    if (path.startsWith("/api/retry/") && method === "POST") {
      const id = decodeURIComponent(path.split("/").pop());
      let index = await env.MAIL_SUMMARY_KV.get("email_index", { type: "json" }) || [];
      const entryIndex = index.findIndex(e => e.id === id);
      
      if (entryIndex !== -1) {
        index[entryIndex].status = 'processing';
        await env.MAIL_SUMMARY_KV.put("email_index", JSON.stringify(index));
        await env.MAIL_SUMMARY_KV.delete(`summary_${id}`);
        
        const body = await env.MAIL_SUMMARY_KV.get(`body_${id}`);
        env.waitUntil(processAI(env, id, index[entryIndex].subject, body));
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ==========================================
    // 3. 前端 UI 
    // ==========================================
    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AI 邮件看板</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      <style>
        body { background-color: #f8fafc; color: #1e293b; }
        .markdown-body { font-size: 15px; color: #334155; line-height: 1.7; }
        .markdown-body h3 { font-size: 1.15rem; font-weight: 700; color: #0f172a; margin: 1.2rem 0 0.5rem 0; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
        .markdown-body p { margin-bottom: 0.8rem; }
        .markdown-body ul { list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem; }
        .markdown-body strong { color: #2563eb; }
        .markdown-body table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 14px; }
        .markdown-body th, .markdown-body td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
        .markdown-body th { background-color: #f1f5f9; font-weight: 600; }
        .pulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #eab308; box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7); animation: pulse 1.5s infinite; }
        @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(234, 179, 8, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); } }
        .skeleton { background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: 4px; }
        @keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        details > summary::marker { display: none; }
        details > summary::-webkit-details-marker { display: none; }
      </style>
    </head>
    <body class="antialiased">
      <div id="app" class="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
        
        <header class="flex justify-between items-center mb-6 bg-white p-5 rounded-2xl shadow-sm border border-gray-200">
          <div>
            <h1 class="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">📬 AI 智能看板</h1>
            <p class="text-sm text-gray-500 mt-1">自动监控新邮件中 <span class="inline-block w-2 h-2 bg-green-500 rounded-full ml-1 animate-pulse"></span></p>
          </div>
          <div class="text-right text-sm text-gray-500 font-medium">共计 {{ totalEmails }} 封</div>
        </header>

        <div v-if="loading && emails.length === 0" class="text-center py-10 text-gray-400">首次加载数据中...</div>

        <div v-else class="space-y-4">
          <div v-for="email in emails" :key="email.id" class="bg-white rounded-xl shadow-sm border transition-all duration-200" :class="activeId === email.id ? 'ring-2 ring-blue-400 border-blue-400' : 'border-gray-200 hover:border-blue-300'">
            
            <div @click="toggle(email)" class="p-4 cursor-pointer flex justify-between items-center gap-4 hover:bg-slate-50 transition-colors" :class="{'rounded-t-xl': activeId === email.id, 'rounded-xl': activeId !== email.id}">
              <div class="flex-shrink-0 text-gray-400 transition-transform duration-300" :class="{'rotate-90': activeId === email.id}">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                  <span v-if="!isRead(email.id)" class="w-2 h-2 rounded-full bg-blue-500"></span>
                  <span class="text-sm font-medium text-gray-600 truncate">{{ email.from.split('<')[0] }}</span>
                  <span class="text-xs text-gray-400">&bull; {{ new Date(email.time).toLocaleString() }}</span>
                </div>
                <h2 class="text-lg font-bold text-gray-800 truncate" :class="{'text-gray-500 font-medium': isRead(email.id)}">{{ email.subject }}</h2>
              </div>
              
              <div class="flex-shrink-0">
                <span v-if="email.status === 'completed'" class="px-2.5 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-lg">✓ 已总结</span>
                <span v-else-if="email.status === 'error'" class="px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 rounded-lg">⚠ 失败</span>
                <span v-else class="px-2.5 py-1 text-xs font-medium bg-yellow-50 text-yellow-700 rounded-lg border border-yellow-200 flex items-center gap-2">
                  <span class="pulse-dot"></span> AI 思考中
                </span>
              </div>
            </div>

            <div v-if="activeId === email.id" class="border-t border-gray-100 bg-gray-50/50 p-5 rounded-b-xl min-h-[150px]">
              
              <div v-if="detailLoading" class="space-y-3 pt-2">
                <div class="h-4 skeleton w-1/3"></div>
                <div class="h-4 skeleton w-full"></div>
                <div class="h-4 skeleton w-5/6"></div>
              </div>

              <div v-else>
                <div v-if="email.status === 'processing'" class="flex flex-col items-center justify-center py-6">
                  <div class="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
                  <p class="text-gray-500 font-medium">模型正在处理，请稍候...</p>
                  <p class="text-xs text-gray-400 mt-2">（完成后将自动在此处显示）</p>
                </div>

                <div v-else-if="email.status === 'completed'" class="bg-white p-6 rounded-lg border border-gray-200 shadow-sm markdown-body" v-html="renderMarkdown(activeDetail.summary)"></div>
                
                <div v-else-if="email.status === 'error'" class="bg-red-50 p-5 rounded-lg border border-red-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <p class="text-red-700 font-bold mb-1">AI 解析异常</p>
                    <p class="text-sm text-red-600 font-mono">{{ activeDetail.summary || '未知错误' }}</p>
                  </div>
                  <button @click="retry(email)" class="flex-shrink-0 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg shadow transition-colors">重新生成</button>
                </div>

                <details v-if="activeDetail.body && email.status !== 'processing'" class="mt-4 group cursor-pointer">
                  <summary class="text-sm text-blue-600 font-medium select-none outline-none flex items-center gap-1">
                    <span>查看原文数据</span>
                    <svg class="w-4 h-4 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                  </summary>
                  <div class="mt-3 bg-slate-800 text-slate-300 p-4 rounded-lg text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-96 overflow-auto cursor-text">{{ activeDetail.body }}</div>
                </details>
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-center items-center gap-6 mt-8" v-if="totalPages > 1">
          <button @click="fetchList(currentPage - 1)" :disabled="currentPage === 1" class="px-4 py-2 bg-white border rounded shadow-sm disabled:opacity-50 text-sm font-medium hover:bg-gray-50">上一页</button>
          <span class="text-sm text-gray-600 font-medium">第 {{ currentPage }} / {{ totalPages }} 页</span>
          <button @click="fetchList(currentPage + 1)" :disabled="currentPage === totalPages" class="px-4 py-2 bg-white border rounded shadow-sm disabled:opacity-50 text-sm font-medium hover:bg-gray-50">下一页</button>
        </div>

      </div>

      <script>
        const { createApp, ref, onMounted, onUnmounted } = Vue;

        createApp({
          setup() {
            const emails = ref([]);
            const loading = ref(true);
            const detailLoading = ref(false); 
            const activeId = ref(null);
            const activeDetail = ref({ summary: '', body: '' });
            const readList = ref(JSON.parse(localStorage.getItem('mail_read_keys') || '[]'));
            
            const totalEmails = ref(0);
            const currentPage = ref(1);
            const totalPages = ref(1);
            
            let pollInterval = null; 
            let autoRefreshInterval = null; 

            const fetchList = async (page = 1, silent = false) => {
              if (!silent) loading.value = true;
              try {
                const res = await fetch(\`/api/emails?page=\${page}\`);
                const data = await res.json();
                
                if (activeId.value) {
                  const activeLocal = emails.value.find(e => e.id === activeId.value);
                  const activeRemote = data.list.find(e => e.id === activeId.value);
                  if (activeLocal && activeLocal.status === 'processing' && activeRemote && activeRemote.status === 'completed') {
                    activeRemote.status = 'processing';
                  }
                }
                
                emails.value = data.list;
                totalEmails.value = data.total;
                currentPage.value = data.page;
                totalPages.value = Math.ceil(data.total / 20) || 1;
              } catch (e) { console.error("获取列表失败"); }
              if (!silent) loading.value = false;
            };

            const fetchDetail = async (email) => {
              try {
                // 前端请求时，也会自动编码 URI
                const res = await fetch(\`/api/emails/\${encodeURIComponent(email.id)}\`);
                const data = await res.json();
                activeDetail.value = data;
                
                const target = emails.value.find(e => e.id === email.id);
                if (target) target.status = data.status;

                if (data.status !== 'processing') stopPolling();
              } catch (e) { console.error("获取详情失败"); }
            };

            const startPolling = (email) => {
              stopPolling();
              pollInterval = setInterval(() => fetchDetail(email), 3000);
            };

            const stopPolling = () => {
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
            };

            const toggle = async (email) => {
              stopPolling(); 

              if (!readList.value.includes(email.id)) {
                readList.value.push(email.id);
                localStorage.setItem('mail_read_keys', JSON.stringify(readList.value));
              }

              if (activeId.value === email.id) {
                activeId.value = null; 
                return;
              }
              
              activeId.value = email.id;
              activeDetail.value = { summary: '', body: '' }; 
              
              if (email.status === 'completed' || email.status === 'error') {
                detailLoading.value = true;
                await fetchDetail(email);
                detailLoading.value = false;
              } else {
                detailLoading.value = false;
                startPolling(email);
              }
            };

            const retry = async (email) => {
              email.status = 'processing';
              activeDetail.value.summary = ''; 
              try {
                await fetch(\`/api/retry/\${encodeURIComponent(email.id)}\`, { method: 'POST' });
                startPolling(email); 
              } catch (e) { alert("请求失败"); }
            };

            const isRead = (id) => readList.value.includes(id);
            const renderMarkdown = (text) => text ? marked.parse(text) : '';

            const startAutoRefresh = () => {
              autoRefreshInterval = setInterval(() => {
                if (currentPage.value === 1) fetchList(1, true);
              }, 10000);
            }

            onMounted(() => {
              fetchList(1);
              startAutoRefresh();
            });
            
            onUnmounted(() => {
              stopPolling();
              if (autoRefreshInterval) clearInterval(autoRefreshInterval);
            });

            return { 
              emails, loading, detailLoading, activeId, activeDetail, toggle, 
              isRead, renderMarkdown, retry, fetchList, currentPage, totalPages, totalEmails 
            };
          }
        }).mount('#app');
      </script>
    </body>
    </html>`;
    return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
  }
};

// ==========================================
// 核心后台逻辑 (修复了中文乱码)
// ==========================================
function extractTextBody(rawEmail) {
  try {
    const base64Match = rawEmail.match(/(?:Content-Transfer-Encoding:\s*base64\s*\n\s*\n)([\s\S]*?)(?=\n--|\n\n--)/i);
    let decodedText = rawEmail;
    
    // 关键修复 2：正确处理 Base64 的 UTF-8 中文解码
    if (base64Match) {
      try {
        const binString = atob(base64Match[1].replace(/\s/g, ''));
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
        decodedText = new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        decodedText = rawEmail; // 失败则回退，绝不乱码
      }
    }
    
    return decodedText
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '\n') 
      .replace(/\n\s*\n/g, '\n\n')
      .replace(/&nbsp;/g, ' ')
      .substring(0, 150000).trim();
  } catch (e) { 
    // 终极保护：即使全盘崩溃，也要回退到 v3.0 的原始纯文本模式
    return rawEmail.replace(/<[^>]+>/g, ' ').substring(0, 20000); 
  }
}

async function processAI(env, msgId, subject, cleanBody) {
  try {
    let finalSummary = "";
    if (cleanBody.length > 40000) {
      const chunks = cleanBody.match(/[\s\S]{1,40000}/g);
      let tempSummaries = [];
      for (let i = 0; i < Math.min(chunks.length, 3); i++) { 
        const chunkSummary = await callDeepSeek(env, subject, `[部分 ${i+1}]:\n${chunks[i]}`);
        tempSummaries.push(chunkSummary);
      }
      finalSummary = await callDeepSeek(env, subject, `这是各部分摘要，请融合成一份最终报告：\n${tempSummaries.join('\n\n')}`);
    } else {
      finalSummary = await callDeepSeek(env, subject, cleanBody);
    }
    await env.MAIL_SUMMARY_KV.put(`summary_${msgId}`, finalSummary);
    await updateIndexStatus(env, msgId, 'completed');
  } catch (err) {
    console.error("AI 报错:", err);
    await env.MAIL_SUMMARY_KV.put(`summary_${msgId}`, `系统级报错原因: ${err.message}`);
    await updateIndexStatus(env, msgId, 'error');
  }
}

async function callDeepSeek(env, subject, content) {
  const payload = {
    model: env.MODEL_NAME,
    messages: [
      { 
        role: 'system', 
        content: `你是一位专业且高效的邮件阅读助手。
        请严格按以下要求输出 Markdown：
        ### 📌 核心摘要
        (一句话概括发件人意图)
        
        ### 📝 关键信息
        (使用列表提取重点)
        
        ### ⚡ 建议处理方式
        (比如：需要回复、仅供知晓、垃圾邮件可直接删除等)`
      },
      { role: 'user', content: `标题: ${subject}\n\n内容: ${content}` }
    ],
    temperature: 0.3
  };

  const response = await fetch(env.API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`模型接口拒绝访问，HTTP状态码: ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "未知 API 错误");
  return data.choices[0].message.content;
}

async function updateIndexStatus(env, msgId, status) {
  let index = await env.MAIL_SUMMARY_KV.get("email_index", { type: "json" }) || [];
  const entryIndex = index.findIndex(e => e.id === msgId);
  if (entryIndex !== -1) {
    index[entryIndex].status = status;
    await env.MAIL_SUMMARY_KV.put("email_index", JSON.stringify(index));
  }
}
