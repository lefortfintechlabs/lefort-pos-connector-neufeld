; Inno Setup (https://jrsoftware.org/isinfo.php). SIN PROBAR: compilar en Windows con la salida de scripts\build-release.ps1.
#define AppName "Lefort POS Connector"
#define AppVersion "0.1.0"

[Setup]
AppId={{7B1E6C3A-5A57-4F55-9E7B-1F0C2A9D4E01}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\Lefort\POS Connector
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=LefortPOSConnectorSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
; SignTool=lefort  (firma Authenticode: SDD §10.1)

[Dirs]
Name: "{commonappdata}\Lefort\POS Connector\config"
Name: "{commonappdata}\Lefort\POS Connector\data"
Name: "{commonappdata}\Lefort\POS Connector\logs"

[Files]
Source: "..\release\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs ignoreversion
Source: "..\release\app\*";     DestDir: "{app}\app";     Flags: recursesubdirs ignoreversion
Source: "winsw\LefortPOSConnector.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "winsw\LefortPOSConnector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "LefortConnector.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\config\connector.example.json"; DestDir: "{commonappdata}\Lefort\POS Connector\config"; Flags: onlyifdoesntexist
Source: "sql\01-create-readonly-access.sql"; DestDir: "{app}\sql"; Flags: ignoreversion
; Controlador ODBC de Microsoft (necesario para Shared Memory / Named Pipes sin TCP/IP). Descargar msodbcsql.msi a installer\redist.
Source: "redist\msodbcsql.msi"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Run]
Filename: "msiexec.exe"; Parameters: "/i ""{tmp}\msodbcsql.msi"" /qn IACCEPTMSODBCSQLLICENSETERMS=YES"; StatusMsg: "Instalando ODBC Driver for SQL Server..."; Flags: skipifdoesntexist; Check: NeedsOdbc
Filename: "{app}\LefortPOSConnector.exe"; Parameters: "install"; Flags: runhidden; StatusMsg: "Registrando el servicio..."
; La cuenta virtual del servicio necesita escribir en config/data/logs (existe solo tras registrar el servicio).
Filename: "icacls.exe"; Parameters: """{commonappdata}\Lefort\POS Connector"" /grant ""NT SERVICE\LefortPOSConnector:(OI)(CI)M"" /T"; Flags: runhidden; StatusMsg: "Ajustando permisos..."
; El servicio NO se inicia solo: primero hay que crear connector.json y el acceso de solo lectura.

[UninstallRun]
Filename: "{app}\LefortPOSConnector.exe"; Parameters: "stop";      Flags: runhidden; RunOnceId: "StopSvc"
Filename: "{app}\LefortPOSConnector.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveSvc"
; Los datos en ProgramData (cola, logs, config) NO se borran: pueden contener eventos pendientes.

[Code]
function NeedsOdbc: Boolean;
begin
  Result := not RegKeyExists(HKLM, 'SOFTWARE\ODBC\ODBCINST.INI\ODBC Driver 18 for SQL Server');
end;
