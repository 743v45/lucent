// 诊断脚本
console.log('[诊断] 开始检查...');

// 检查 DOM
const root = document.getElementById('root');
if (!root) {
    console.error('[诊断] ❌ 找不到 #root 元素');
} else {
    console.log('[诊断] ✅ #root 元素存在');
}

// 检查 React
if (typeof ReactDOM !== 'undefined') {
    console.log('[诊断] ✅ ReactDOM 已加载');
} else {
    console.error('[诊断] ❌ ReactDOM 未加载');
}

// 检查 API
fetch('/api/logs')
    .then(r => r.json())
    .then(data => {
        console.log('[诊断] ✅ API 连接成功，日志数量:', data.logs.length);
        console.log('[诊断] 第一条日志:', data.logs[0]);
    })
    .catch(err => {
        console.error('[诊断] ❌ API 连接失败:', err);
    });

// 检查控制台错误
window.addEventListener('error', (e) => {
    console.error('[诊断] ❌ 全局错误:', e.message, e.filename, e.lineno);
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('[诊断] ❌ Promise 错误:', e.reason);
});

console.log('[诊断] 诊断脚本已加载，5秒后自动重定向...');
setTimeout(() => {
    console.log('[诊断] 如果页面正常，请忽略此消息');
}, 5000);