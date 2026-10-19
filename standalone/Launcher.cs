using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

public enum InstallPhase { Confirmation, Waiting, Running, Done, Failed, Canceled }

public sealed class InstallState {
    public InstallPhase Phase { get; private set; }
    private readonly bool uninstall;
    private int quietTicks;
    public InstallState(bool uninstall) { this.uninstall = uninstall; Phase = InstallPhase.Confirmation; }
    public bool Begin(bool confirmed) {
        if (Phase != InstallPhase.Confirmation || (uninstall && !confirmed)) return false;
        Phase = InstallPhase.Waiting;
        return true;
    }
    public bool Tick(bool photoshopRunning) {
        if (Phase != InstallPhase.Waiting) return false;
        quietTicks = photoshopRunning ? 0 : quietTicks + 1;
        if (quietTicks < 2) return false;
        Phase = InstallPhase.Running;
        return true;
    }
    public bool Cancel() {
        if (Phase != InstallPhase.Confirmation && Phase != InstallPhase.Waiting) return false;
        Phase = InstallPhase.Canceled;
        return true;
    }
    public void Complete(bool success) { Phase = success ? InstallPhase.Done : InstallPhase.Failed; }
}

public sealed class InstallerForm : Form {
    public readonly InstallState State;
    public readonly Button ConfirmButton;
    private readonly bool uninstall;
    private readonly Func<bool> photoshopRunning;
    private readonly Func<Action<string>, Task<int>> backend;
    private readonly Label heading, description, status;
    private readonly TextBox log;
    private readonly Button cancel;
    private readonly ProgressBar progress;
    private readonly System.Windows.Forms.Timer timer;

    public InstallerForm(bool uninstall, Func<bool> photoshopRunning, Func<Action<string>, Task<int>> backend) {
        this.uninstall = uninstall;
        this.photoshopRunning = photoshopRunning;
        this.backend = backend;
        State = new InstallState(uninstall);
        Text = uninstall ? "Sliceman · 卸载" : "Sliceman · 安装";
        ClientSize = new Size(560, 405);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(247, 249, 252);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var picture = new PictureBox { Bounds = new Rectangle(28, 27, 48, 48), SizeMode = PictureBoxSizeMode.Zoom };
        if (Icon != null) picture.Image = Icon.ToBitmap();
        Controls.Add(picture);
        heading = LabelAt(uninstall ? "卸载 Sliceman" : "安装 Sliceman", 92, 24, 438, 36);
        heading.Font = new Font(Font.FontFamily, 19, FontStyle.Bold);
        description = LabelAt(uninstall ? "只卸载此独立版本，保留原版及其他插件。" : "自动等待 Photoshop 退出，完成后下次启动生效。", 92, 64, 438, 43);
        description.ForeColor = Color.FromArgb(88, 101, 119);
        status = LabelAt(uninstall ? "确定要卸载 Sliceman 吗？点击“确认卸载”继续。" : "正在准备安装…", 28, 119, 504, 46);
        ConfirmButton = new Button { Text = "确认卸载", Bounds = new Rectangle(292, 347, 116, 34), Visible = uninstall, Enabled = true };
        ConfirmButton.FlatStyle = FlatStyle.Flat;
        ConfirmButton.BackColor = Color.FromArgb(255, 237, 232);
        ConfirmButton.ForeColor = Color.FromArgb(178, 57, 32);
        Controls.Add(ConfirmButton);
        ConfirmButton.Click += delegate { StartWaiting(); };
        progress = new ProgressBar { Bounds = new Rectangle(28, 179, 504, 8), Visible = !uninstall, Style = ProgressBarStyle.Marquee };
        Controls.Add(progress);
        log = new TextBox { Bounds = new Rectangle(28, 222, 504, 103), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Font = new Font(Font.FontFamily, 9) };
        Controls.Add(log);
        cancel = new Button { Text = "取消", Bounds = new Rectangle(420, 347, 112, 34) };
        cancel.Click += delegate { if (State.Phase == InstallPhase.Done || State.Phase == InstallPhase.Failed) Close(); else CancelWaiting(); };
        Controls.Add(cancel);
        LabelAt("操作期间请勿重新启动 Photoshop。", 28, 193, 504, 26).ForeColor = Color.FromArgb(110, 120, 135);
        timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += async delegate {
            try {
                bool running = photoshopRunning();
                status.Text = running ? "等待 Photoshop 退出…\r\n请先保存文件并正常退出，也可以取消本次操作。" : "Photoshop 已退出，正在确认进程已完全结束…";
                if (State.Tick(running)) {
                    timer.Stop();
                    cancel.Enabled = false;
                    status.Text = uninstall ? "正在卸载，请稍候…" : "正在安装，请稍候…";
                    int result = await backend(AppendLog);
                    State.Complete(result == 0);
                    status.Text = result == 0 ? (uninstall ? "卸载完成" : "安装完成") : "操作未完成，请查看下方中文提示。";
                    if (result == 0) {
                        status.Font = new Font(Font.FontFamily, 20, FontStyle.Bold);
                        description.Text = uninstall ? "原版及其他插件已保留。" : "请启动 Photoshop，在“增效工具”中打开 Sliceman。";
                    }
                    progress.Visible = false;
                    cancel.Text = "关闭";
                    cancel.Enabled = true;
                }
            } catch (Exception error) {
                timer.Stop();
                State.Complete(false);
                status.Text = "操作未完成。请检查安装包和文件权限后重试。";
                AppendLog(LauncherProgram.SaveDiagnostic(error.ToString()));
                cancel.Text = "关闭";
                cancel.Enabled = true;
                progress.Visible = false;
            }
        };
        Shown += delegate { if (!uninstall) StartWaiting(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (State.Phase == InstallPhase.Running) {
                e.Cancel = true;
                MessageBox.Show(this, "正在写入插件文件，请等待操作完成后再关闭窗口。", "请稍候", MessageBoxButtons.OK, MessageBoxIcon.Information);
            } else { State.Cancel(); timer.Stop(); }
        };
        FormClosed += delegate { timer.Dispose(); if (picture.Image != null) picture.Image.Dispose(); };
    }
    private Label LabelAt(string text, int x, int y, int width, int height) {
        var label = new Label { Text = text, Bounds = new Rectangle(x, y, width, height), ForeColor = Color.FromArgb(30, 42, 58) };
        Controls.Add(label);
        return label;
    }
    public void StartWaiting() {
        if (!State.Begin(true)) return;
        ConfirmButton.Visible = false;
        progress.Visible = true;
        status.Text = "等待 Photoshop 退出…\r\n请先保存文件并正常退出，也可以取消本次操作。";
        AppendLog(uninstall ? "卸载已确认。等待期间不会修改插件文件。" : "安装已准备。等待期间不会修改插件文件。");
        timer.Start();
    }
    public void CancelWaiting() {
        if (!State.Cancel()) return;
        timer.Stop();
        Close();
    }
    private void AppendLog(string text) {
        if (String.IsNullOrWhiteSpace(text) || IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(AppendLog), text); return; }
        log.AppendText(text.Trim() + Environment.NewLine);
    }
}

public static class LauncherProgram {
    public static string SaveDiagnostic(string detail) {
        try {
            string path = Path.Combine(Path.GetTempPath(), "Sliceman-" + Guid.NewGuid().ToString("N") + ".log");
            File.WriteAllText(path, detail, new UTF8Encoding(false));
            return "诊断日志已保存：" + path;
        } catch { return "无法保存诊断日志，请检查临时目录的写入权限。"; }
    }
    private static bool PhotoshopRunning() {
        var processes = Process.GetProcessesByName("Photoshop");
        try { return processes.Length != 0; }
        finally { foreach (var process in processes) process.Dispose(); }
    }
    private static Task<int> RunBackend(bool uninstall, Action<string> log) {
        return Task.Run(delegate {
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "install.ps1");
            if (!File.Exists(script)) { log("安装包不完整：缺少 install.ps1，请完整解压安装包后重试。"); return 1; }
            var info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"" + (uninstall ? " -Uninstall" : ""),
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            using (var process = new Process { StartInfo = info }) {
                process.Start();
                // Drain both streams concurrently to avoid a full-pipe deadlock.
                Task<string> errors = process.StandardError.ReadToEndAsync();
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null) log(line);
                process.WaitForExit();
                string error = errors.GetAwaiter().GetResult();
                if (!String.IsNullOrWhiteSpace(error)) {
                    log("脚本执行遇到问题，请确认安装包完整，且系统允许运行 PowerShell。");
                    log(SaveDiagnostic(error));
                }
                return process.ExitCode;
            }
        });
    }
    [STAThread]
    public static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool uninstall = false;
#if UNINSTALL
        uninstall = true;
#endif
        bool owned = false;
        using (var mutex = new Mutex(false, "Local\\SlicemanLocalLauncher")) {
            try {
                try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                if (!owned) { MessageBox.Show("已有安装或卸载窗口打开，请先完成或取消该操作。", "Sliceman", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
                Application.Run(new InstallerForm(uninstall, PhotoshopRunning, delegate(Action<string> log) { return RunBackend(uninstall, log); }));
            } catch (Exception error) {
                MessageBox.Show("无法启动安装程序，请检查文件权限。\r\n" + SaveDiagnostic(error.ToString()), "Sliceman", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } finally { if (owned) mutex.ReleaseMutex(); }
        }
    }
}
