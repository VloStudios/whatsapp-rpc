# Polls the Windows media session (SMTC) and prints one JSON line whenever the state changes.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

$browsers = @{ brave='Brave'; chrome='Chrome'; msedge='Edge'; firefox='Firefox'; opera='Opera'; vivaldi='Vivaldi' }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# Titles of every open tab in the given browser's windows (read-only, titles only).
function Get-TabTitles($procName) {
  $names = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($p in (Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
      $wins = $root.FindAll('Children', (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)))
      foreach ($w in $wins) {
        $tabs = $w.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)))
        foreach ($t in $tabs) { if ($t.Current.Name) { $names += $t.Current.Name } }
      }
    }
  } catch { }
  return $names
}

$platformCache = @{}

function Get-Platform($app, $title) {
  $ck = "$app|$title"
  if ($script:platformCache.ContainsKey($ck)) { return $script:platformCache[$ck] }
  $r = Get-PlatformUncached $app $title
  # cache only definite answers (not the bare browser-name fallback), one track at a time
  if (-not $browsers.Values.Contains($r)) { $script:platformCache = @{ $ck = $r } }
  return $r
}

function Get-PlatformUncached($app, $title) {
  $id = ("$app").ToLower()
  if ($id -match 'spotify') { return 'Spotify' }
  if ($id -match 'applemusic|itunes') { return 'Apple Music' }
  if ($id -match 'deezer') { return 'Deezer' }
  if ($id -match 'tidal') { return 'Tidal' }
  foreach ($key in $browsers.Keys) {
    if ($id -match $key) {
      # Browser: guess the site from tab titles (all tabs via UI Automation, plus window titles)
      $titles = @(Get-Process -Name $key -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle } | Where-Object { $_ })
      $titles += Get-TabTitles $key
      $hit = $titles | Where-Object { $title -and $_.Contains($title) } | Select-Object -First 1
      if (-not $hit) { $hit = $titles -join ' | ' }
      $sites = @(
        @('YouTube Music','YT Music'), @('SoundCloud','SoundCloud'), @('Spotify','Spotify'),
        @('Apple Music','Apple Music'), @('Deezer','Deezer'), @('Tidal','Tidal'),
        @('Bandcamp','Bandcamp'), @('YouTube','YouTube')
      )
      foreach ($s in $sites) { if ($hit -and $hit.Contains($s[0])) { return $s[1] } }
      return $browsers[$key]
    }
  }
  return ($app -replace '\.exe$','')
}

$last = ''
while ($true) {
  $out = @{ playing = $false }
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $info = $s.GetPlaybackInfo()
      $props = Await ($s.TryGetMediaPropertiesAsync()) $propType
      $out = @{
        playing = ($info.PlaybackStatus.ToString() -eq 'Playing')
        title   = $props.Title
        artist  = $props.Artist
        app     = $s.SourceAppUserModelId
        platform = (Get-Platform $s.SourceAppUserModelId $props.Title)
      }
    }
  } catch { }
  $json = $out | ConvertTo-Json -Compress
  if ($json -ne $last) { Write-Output $json; $last = $json }
  Start-Sleep -Seconds 2
}
