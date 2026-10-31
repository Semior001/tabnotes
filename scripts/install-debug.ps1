# Loads an unpacked extension into the Windows Firefox as a temporary add-on, for `task install:debug` in WSL.
# web-ext cannot do this from WSL: it passes Linux paths to Firefox, and under NAT networking WSL
# cannot reach a debugger port on the Windows loopback. So this runs on Windows and speaks Firefox's
# remote debugging protocol itself. A second run finds Firefox up and reloads the add-on.
param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
$port = 6005
$profileDir = Join-Path $env:TEMP 'tabnotes-dev'

function Connect-Debugger {
  try { return [Net.Sockets.TcpClient]::new('127.0.0.1', $port) } catch { return $null }
}

# frames are "<byte length>:<json>"
function Read-Frame($stream) {
  $len = ''
  while (($c = $stream.ReadByte()) -ne [int][char]':') {
    if ($c -lt 0) { throw 'debugger closed the connection' }
    $len += [char]$c
  }
  $buf = [byte[]]::new([int]$len)
  $got = 0
  while ($got -lt $buf.Length) {
    $n = $stream.Read($buf, $got, $buf.Length - $got)
    if ($n -le 0) { throw 'debugger closed the connection' }
    $got += $n
  }
  return [Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json
}

function Send-Request($stream, $request) {
  $json = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
  $frame = [Text.Encoding]::ASCII.GetBytes("$($json.Length):") + $json
  $stream.Write($frame, 0, $frame.Length)
  # the actor also sends events, which have a type; its reply to these requests has none or an error
  while ($true) {
    $reply = Read-Frame $stream
    if ($reply.from -ne $request.to) { continue }
    if ($reply.error) { throw "$($request.type): $($reply.error): $($reply.message)" }
    if (-not $reply.type) { return $reply }
  }
}

$client = Connect-Debugger
if (-not $client) {
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  Set-Content (Join-Path $profileDir 'user.js') -Encoding ASCII @(
    'user_pref("devtools.chrome.enabled", true);'
    'user_pref("devtools.debugger.remote-enabled", true);'
    'user_pref("devtools.debugger.prompt-connection", false);'
    'user_pref("browser.aboutwelcome.enabled", false);'
    'user_pref("browser.shell.checkDefaultBrowser", false);'
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);'
  )
  # -no-remote keeps it apart from a Firefox that is already running on the default profile
  Start-Process firefox -ArgumentList '-no-remote', '-profile', "`"$profileDir`"", '-start-debugger-server', $port
  foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 500
    if ($client = Connect-Debugger) { break }
  }
  if (-not $client) { throw "firefox did not open debugger port $port" }
}

$stream = $client.GetStream()
$stream.ReadTimeout = 30000
Read-Frame $stream | Out-Null
$root = Send-Request $stream @{ to = 'root'; type = 'getRoot' }
$installed = Send-Request $stream @{ to = $root.addonsActor; type = 'installTemporaryAddon'; addonPath = $Path; openDevTools = $false }
$client.Close()
Write-Output "installed $($installed.addon.id) into the Windows Firefox, profile $profileDir"
