import fs from 'node:fs';

/** 04 §3 安装提示词全文（占位符 {{HUB_URL}} / {{ENROLL_TOKEN}}） */
export const INSTALL_PROMPT_TEMPLATE = `请把本机接入 Kizuna · Agent 通讯录，安装并部署端侧服务 Kizuna Box。严格按步骤执行：
1. 探测当前系统（Linux / macOS / Windows / Android-Termux / 其他）。「其他」一律终止并说明原因。
2. 用对应平台的一键脚本安装（HUB={{HUB_URL}}，ENROLL_TOKEN={{ENROLL_TOKEN}}，令牌一次性、10分钟内有效，请立即执行）：
   - Linux:   curl -fsSL "{{HUB_URL}}/install/linux.sh?token={{ENROLL_TOKEN}}" | bash
   - macOS:   curl -fsSL "{{HUB_URL}}/install/macos.sh?token={{ENROLL_TOKEN}}" | bash
   - Windows: powershell -c "irm '{{HUB_URL}}/install/windows.ps1?token={{ENROLL_TOKEN}}' | iex"
   - Termux:  curl -fsSL "{{HUB_URL}}/install/termux.sh?token={{ENROLL_TOKEN}}" | bash
   脚本会自动：安装运行时（如缺失）→ 下载服务 → 用令牌完成注册（换取正式凭据、回填 webhook）→
   配置开机自启 → 启动服务。
3. 自检：请求 http://127.0.0.1:7788/healthz，确认 ok=true 且 agent_id 非空；
   再确认本机 Agent 可用 GET /tasks/pending 读到信箱。
4. 汇报：系统类型、agent_id、webhook 地址、自启方式（服务名/单元名）、自检结果。
   任何一步失败：给出失败原因、已执行的命令与修复建议，不要静默重试超过 3 次。
`;

export function renderPrompt(hubUrl: string, token: string): string {
  return INSTALL_PROMPT_TEMPLATE.replaceAll('{{HUB_URL}}', hubUrl).replaceAll('{{ENROLL_TOKEN}}', token);
}

/** 平台安装脚本模板（hub 启动时从 install/ 目录读入，内存缓存） */
const SCRIPT_FILES: Record<string, string> = {
  'linux.sh': 'install/linux.sh',
  'macos.sh': 'install/macos.sh',
  'windows.ps1': 'install/windows.ps1',
  'termux.sh': 'install/termux.sh',
};

const cache = new Map<string, string>();

export function loadScriptTemplates(hubRootCandidates: string[]): void {
  for (const [name, rel] of Object.entries(SCRIPT_FILES)) {
    for (const root of hubRootCandidates) {
      const p = `${root}/${rel}`;
      if (fs.existsSync(p)) {
        cache.set(name, fs.readFileSync(p, 'utf8'));
        break;
      }
    }
    if (!cache.has(name)) {
      throw new Error(`安装脚本缺失: ${rel}（在 ${hubRootCandidates.join(', ')} 下均未找到）`);
    }
  }
}

export function renderScript(name: string, hubUrl: string, token: string): string | null {
  const tpl = cache.get(name);
  if (!tpl) return null;
  return tpl.replaceAll('__KIZUNA_HUB__', hubUrl).replaceAll('__KIZUNA_TOKEN__', token);
}
