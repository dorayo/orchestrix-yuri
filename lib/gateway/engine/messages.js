'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Language Detection ──────────────────────────────────────────────────────

let _cachedLang = null;
let _langCheckedAt = 0;
const LANG_CACHE_TTL = 300000; // 5 min

/**
 * Detect user language from boss/preferences.yaml.
 * Falls back to 'en'. Caches for 5 min.
 */
function detectLang() {
  const now = Date.now();
  if (_cachedLang && now - _langCheckedAt < LANG_CACHE_TTL) return _cachedLang;

  _langCheckedAt = now;
  try {
    const prefPath = path.join(os.homedir(), '.yuri', 'boss', 'preferences.yaml');
    if (fs.existsSync(prefPath)) {
      const content = fs.readFileSync(prefPath, 'utf8');
      // Quick extraction without yaml dependency (preferences.yaml is simple)
      const match = content.match(/language:\s*["']?(\w+)/);
      if (match && match[1]) {
        const lang = match[1].toLowerCase();
        _cachedLang = lang.startsWith('zh') ? 'zh' : 'en';
        return _cachedLang;
      }
    }
  } catch { /* fallback */ }

  _cachedLang = 'en';
  return _cachedLang;
}

/** Override language (useful for testing). */
function setLang(lang) {
  _cachedLang = lang;
  _langCheckedAt = Date.now();
}

// ── Message Templates ───────────────────────────────────────────────────────

const MESSAGES = {
  // ── Phase Completion ──
  plan_complete: {
    en: '🎉 Planning complete!{summary}\n\nNext: review the docs above, then run `*develop` to start building.',
    zh: '🎉 规划完成！{summary}\n\n下一步：检查上面的文档，然后运行 `*develop` 开始开发。',
  },
  dev_complete: {
    en: '🎉 Development complete! All stories implemented.\n\nNext: run `*test` to validate each epic with smoke tests.',
    zh: '🎉 开发完成！所有 story 已实现。\n\n下一步：运行 `*test` 对每个 epic 进行冒烟测试。',
  },
  test_all_passed: {
    en: '\n🚀 All tests passed! Run `*deploy` when ready.',
    zh: '\n🚀 全部测试通过！准备好后运行 `*deploy` 部署。',
  },
  test_some_failed: {
    en: '\n⚠️ {count} epic(s) failed. Review and fix manually, or run `*test` again.',
    zh: '\n⚠️ {count} 个 epic 未通过。手动修复后重新运行 `*test`。',
  },
  iterate_launched: {
    en: '🔄 New iteration launched!\n\nSM is drafting new stories. Agents will chain automatically (SM → Architect → Dev → QA).',
    zh: '🔄 新迭代已启动！\n\nSM 正在拆分新 story，Agent 将自动接力（SM → Architect → Dev → QA）。',
  },

  // ── Phase Start ──
  dev_started: {
    en: '🚀 Development started! 4 agents (Architect, SM, Dev, QA) are running.\n\nAgents chain automatically via handoff-detector. I\'ll send a progress report every {minutes} minutes.',
    zh: '🚀 开发已启动！4 个 Agent（Architect、SM、Dev、QA）正在工作。\n\nAgent 通过 handoff-detector 自动接力。我每 {minutes} 分钟发送一次进度报告。',
  },

  // ── Change / Direct Agent ──
  change_small: {
    en: '🔧 Small change started → Dev *solo\n\n"{desc}"\n\nI\'ll notify you when it\'s done.',
    zh: '🔧 小改动已启动 → Dev *solo\n\n"{desc}"\n\n完成后我会通知你。',
  },
  change_medium: {
    en: '🔧 {scope} change started → PO *route-change\n\n"{desc}"\n\nPO will assess and route to the right agent. I\'ll keep you updated.',
    zh: '🔧 {scope}级改动已启动 → PO *route-change\n\n"{desc}"\n\nPO 评估后分配给合适的 Agent，我会持续更新。',
  },
  direct_agent: {
    en: '🎯 → **{agent}**\n\n"{desc}"\n\nI\'ll notify you when done.',
    zh: '🎯 → **{agent}**\n\n"{desc}"\n\n完成后通知你。',
  },
  quickfix_started: {
    en: '🐛 Quick fix started → Dev *quick-fix\n\n"{desc}"\n\nI\'ll notify you when it\'s done.',
    zh: '🐛 快速修复已启动 → Dev *quick-fix\n\n"{desc}"\n\n完成后通知你。',
  },

  // ── Progress ──
  agent_handoff: {
    en: '🔄 {from} → **{to}**{story}',
    zh: '🔄 {from} → **{to}**{story}',
  },
  monitoring_dev: {
    en: '🔄 Now monitoring dev cycle (SM → Architect → Dev → QA). I\'ll report agent handoffs and progress.',
    zh: '🔄 正在监控开发流程（SM → Architect → Dev → QA），我会汇报 Agent 交接和进度。',
  },
  change_complete: {
    en: '✅ Change complete.\n\n{summary}\n\nWhat would you like to do next?',
    zh: '✅ 改动完成。\n\n{summary}\n\n接下来要做什么？',
  },

  // ── Errors ──
  error_recovery: {
    en: {
      plan:    'Run `*plan` to restart, or `*status` to check saved progress.',
      develop: 'Run `*develop` to restart, or `*status` to see completed stories.',
      test:    'Run `*test` to restart testing.',
      change:  'Send your change request again.',
      iterate: 'Run `*iterate` again.',
      default: 'Use `*status` to check current state.',
    },
    zh: {
      plan:    '运行 `*plan` 重新开始，或 `*status` 查看已保存的进度。',
      develop: '运行 `*develop` 重新开始，或 `*status` 查看已完成的 story。',
      test:    '运行 `*test` 重新测试。',
      change:  '重新发送你的改动请求。',
      iterate: '重新运行 `*iterate`。',
      default: '使用 `*status` 查看当前状态。',
    },
  },
  timeout: {
    en: '⏱ This is taking longer than usual. The operation may still be running.\n\nTry `*status` to check progress, or send your message again.',
    zh: '⏱ 处理时间较长，操作可能仍在进行中。\n\n试试 `*status` 查看进度，或重新发送消息。',
  },
  cli_error: {
    en: '❌ Something went wrong. Try again, or use `*status` to check state.',
    zh: '❌ 出了点问题。请重试，或使用 `*status` 查看状态。',
  },

  // ── Status ──
  no_phase: {
    en: 'No active phase. Available commands: *plan, *develop, *test, *deploy, *projects, *switch',
    zh: '当前无活跃阶段。可用命令：*plan、*develop、*test、*deploy、*projects、*switch',
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a localized message by key with parameter substitution.
 * @param {string} key - Message key (e.g., 'plan_complete')
 * @param {object} params - Substitution params (e.g., { summary: '...' })
 * @returns {string}
 */
function msg(key, params = {}) {
  const lang = detectLang();
  const template = MESSAGES[key];
  if (!template) return key;

  let text = template[lang] || template.en || key;

  // Handle nested objects (like error_recovery)
  if (typeof text === 'object') {
    const subKey = params._sub || 'default';
    text = text[subKey] || text.default || JSON.stringify(text);
  }

  // Substitute {param} placeholders
  return text.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
}

module.exports = { msg, detectLang, setLang, MESSAGES };
