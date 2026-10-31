# Kizuna Box — Windows 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：注册（先用令牌换正式凭据并落盘）→ 安装运行时（如缺失，winget）→ 下载服务
#       → 写入 config → WinSW 托管的 Windows 服务
#       （无管理员权限时退化为计划任务：登录自启 + 失败重启）→ 自检
# 注册排在最前：令牌是一次性资源，后面的装运行时/下载再慢也不会把它拖过期。
# 升级/续装：重跑本脚本即同路径覆盖 bin，保留 spool 与 config；已注册则跳过注册。
$ErrorActionPreference = 'Stop'

$HUB   = '__KIZUNA_HUB__'
$TOKEN = '__KIZUNA_TOKEN__'

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($IsAdmin) {
  $Root       = 'C:\Program Files\Kizuna Box'
  $ConfigDir  = 'C:\ProgramData\Kizuna Box'
} else {
  Write-Host '[kizuna-box] 未以管理员运行：改用计划任务方式（登录自启 + 失败重启）'
  $Root       = Join-Path $env:LOCALAPPDATA 'KizunaBox'
  $ConfigDir  = Join-Path $env:APPDATA 'KizunaBox'
}
$BinDir     = Join-Path $Root 'bin'
$ConfigPath = Join-Path $ConfigDir 'config.json'
$EnrollPath = Join-Path $ConfigDir 'enroll.json'
$BoxPath    = Join-Path $BinDir 'kizuna-box'

function Say($m)  { Write-Host "[kizuna-box] $m" }
function Fail($m) { Write-Host "[kizuna-box][ERROR] $m" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $BinDir, $ConfigDir | Out-Null

# ---------- 1. 注册（已注册则跳过） ----------
$haveConfig = $false
if (Test-Path $ConfigPath) {
  try {
    $prev = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    if ($prev.agent_id -and $prev.agent_token -and $prev.endpoint_secret) { $haveConfig = $true }
  } catch { }
}
if ($haveConfig) {
  Say '检测到已有配置：跳过注册，保留 config 与 spool'
} elseif ((Test-Path $EnrollPath) -and ((Get-Item $EnrollPath).Length -gt 0)) {
  Say '检测到上次注册凭据：跳过注册，继续安装'
} else {
  # 探测局域网 IPv4
  $lanIp = '127.0.0.1'
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
      Sort-Object InterfaceMetric | Select-Object -First 1
    if ($ip) { $lanIp = $ip.IPAddress }
  } catch { }
  $webhook = "http://${lanIp}:7788"
  Say "注册到 Hub（webhook=$webhook）..."
  $payload = @{ token = $TOKEN; webhook_url = $webhook } | ConvertTo-Json
  $cred = $null
  for ($i = 1; $i -le 3; $i++) {
    try {
      $cred = Invoke-RestMethod -Method Post -Uri "$HUB/api/v1/enroll" -ContentType 'application/json' -Body $payload -TimeoutSec 60
      break
    } catch {
      $msg = $_.Exception.Message
      # 410 的响应体在 ErrorDetails 里，不在异常消息中
      $detail = ''
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
      $all = "$msg $detail"
      if ($all -match 'ENROLL_TOKEN_EXPIRED') {
        Fail '注册令牌已过期（HTTP 410）。请在管理台重新生成安装提示词，用新提示词重跑；本机已有部分安装文件，重跑会复用。'
      }
      if ($all -match 'ENROLL_TOKEN_USED') {
        Fail '注册令牌已被使用（HTTP 410）。若本机已装好，直接重跑即可；否则请重新生成安装提示词。'
      }
      if ($all -match '\b410\b' -or $all -match 'ENROLL_TOKEN') {
        Fail "注册失败: $msg $detail"
      }
      if ($i -eq 3) {
        Fail "无法连接 Hub（$HUB）: $msg。请检查网络/代理后重跑本脚本；令牌在有效期内仍可用。"
      }
      $wait = $i * 3
      Say "注册请求连接失败（第 $i/3 次），${wait}s 后重试..."
      Start-Sleep -Seconds $wait
    }
  }
  if (-not $cred) { Fail "注册失败：未取得凭据（Hub: $HUB）" }
  $cred | ConvertTo-Json -Depth 4 | Out-File -FilePath $EnrollPath -Encoding utf8
  Say "注册成功：凭据已暂存（完成后写入 config.json）"
}

# ---------- 2. 运行时：Node.js >= 18 ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '未检测到 Node.js，尝试 winget 安装 OpenJS.NodeJS.LTS ...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
}
if (-not $node) {
  Fail "未找到 Node.js 且 winget 不可用。请手动安装 Node.js 20（https://nodejs.org/）后重跑本脚本（注册已完成，不会重复消耗令牌）"
}
$nodeVersion = (& node -p 'process.versions.node').Split('.')[0]
if ([int]$nodeVersion -lt 18) { Fail "Node.js 版本过低（$(& node --version)），需要 >= 18（注册已完成，升级后重跑即可续装）" }
Say "Node.js 就绪: $(& node --version)"

# ---------- 3. 下载服务（失败重试） ----------
$boxOk = $false
for ($i = 1; $i -le 5; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$HUB/install/box.js" -OutFile $BoxPath -TimeoutSec 300
    $boxOk = $true
    break
  } catch {
    if ($i -eq 5) { break }
    $wait = $i * 3
    Say "下载服务失败（第 $i/5 次），${wait}s 后重试..."
    Start-Sleep -Seconds $wait
  }
}
if (-not $boxOk) { Fail "服务下载失败（Hub: $HUB）。网络恢复后重跑本脚本即可续装，凭据已保存不会重复消耗令牌。" }
Say "服务已下载: $BoxPath"

# ---------- 4. 写入端侧配置 ----------
if ($haveConfig) {
  Say '升级模式：保留现有 config'
} else {
  if (-not (Test-Path $EnrollPath)) { Fail "缺少注册凭据（$EnrollPath），请重新生成安装提示词后重跑" }
  $cred = Get-Content $EnrollPath -Raw | ConvertFrom-Json
  $cfg = [ordered]@{
    hub_url         = $HUB
    agent_id        = $cred.agent_id
    agent_token     = $cred.agent_token
    endpoint_secret = $cred.endpoint_secret
    webhook_url     = $cred.webhook_url
    listen          = @{ host = '0.0.0.0'; port = 7788 }
    heartbeat_interval_s = 60
  }
  $cfg | ConvertTo-Json -Depth 4 | Out-File -FilePath $ConfigPath -Encoding utf8
  Remove-Item $EnrollPath -ErrorAction SilentlyContinue
  Say "凭据已写入: $ConfigPath (agent_id=$($cred.agent_id))"
}

# ---------- 5. 开机自启 + 崩溃拉起 ----------
if ($IsAdmin) {
  # WinSW 托管的 Windows 服务（服务身份自启，无需登录；onfailure 自动重启）
  $SvcExe = Join-Path $BinDir 'kizuna-box-service.exe'
  $SvcXml = Join-Path $BinDir 'kizuna-box-service.xml'
  if (-not (Test-Path $SvcExe)) {
    Say '下载 WinSW ...'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile $SvcExe
  }
  $nodePath = (Get-Command node).Source
  @"
<service>
  <id>kizuna-box</id>
  <name>Kizuna Endpoint</name>
  <description>Kizuna端侧接收服务</description>
  <executable>"$nodePath"</executable>
  <arguments>"$BoxPath" run --config "$ConfigPath"</arguments>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@ | Out-File -FilePath $SvcXml -Encoding utf8

  Stop-Service kizuna-box -ErrorAction SilentlyContinue
  & $SvcExe uninstall | Out-Null
  & $SvcExe install | Out-Null
  & $SvcExe start | Out-Null
  Say 'Windows 服务已安装并启动: kizuna-box（Automatic + 失败 5s 重启）'
} else {
  # 计划任务：登录时启动 + 失败自动重启（无管理员权限的备选路径）
  $action = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "`"$BoxPath`" run --config `"$ConfigPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName 'KizunaBox' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'KizunaBox'
  Say '计划任务已注册并启动: KizunaBox（登录自启 + 失败重启）'
}

# ---------- 6. 自检 ----------
Start-Sleep -Seconds 3
Say '===== 自检报告 ====='
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/healthz' -TimeoutSec 5
  Say "① healthz ......... OK  ok=$($h.ok) agent_id=$($h.agent_id)"
  $healthOk = $true
} catch {
  Say '① healthz ......... FAIL（查看服务日志 / 事件查看器）'
  $healthOk = $false
}
try {
  Invoke-RestMethod -Uri "$HUB/healthz" -TimeoutSec 5 | Out-Null
  Say '③ Hub 连通 ........ OK'
  $hubOk = $true
} catch {
  Say "③ Hub 连通 ........ FAIL（Hub 不可达: $HUB）"
  $hubOk = $false
}
if ($IsAdmin) {
  $svc = Get-Service kizuna-box -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') { Say "② 服务状态 ........ OK  (kizuna-box: Running)"; $svcOk = $true }
  else { Say "② 服务状态 ........ FAIL (kizuna-box: $($svc.Status))"; $svcOk = $false }
} else {
  $t = Get-ScheduledTask -TaskName 'KizunaBox' -ErrorAction SilentlyContinue
  if ($t -and $t.State -ne 'Disabled') { Say "② 服务状态 ........ OK  (计划任务: $($t.State))"; $svcOk = $true }
  else { Say '② 服务状态 ........ FAIL (计划任务未运行)'; $svcOk = $false }
}
if ($healthOk -and $hubOk -and $svcOk) {
  Say '✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）'
} else {
  Say '⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。'
  exit 1
}
