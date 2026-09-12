' Launch the MoonBot manager with a hidden window.
' wscript is a GUI host, so no console is created; Run arg 2 = 0 hides the window,
' arg 3 = False means do not wait.
' Usage: wscript.exe start-manager-hidden.vbs
'
' IMPORTANT: this file must stay portable. The runtime root is derived from this
' script's own location, never hardcoded -- the whole install tree can live on any
' drive/path (and be handed to another machine/user) and must still work.
Option Explicit
Dim sh, fso, base, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
If base = "" Then base = fso.GetAbsolutePathName(".")
exe = base & "\qbm-node.exe"
If Not fso.FileExists(exe) Then
  WScript.Echo "qbm-node.exe not found in: " & base
  WScript.Quit 1
End If
sh.CurrentDirectory = base
sh.Run """" & exe & """ server\index.js", 0, False
