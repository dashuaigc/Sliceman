using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

class LauncherTests {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Pump(int milliseconds) {
        var until = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < until) { Application.DoEvents(); System.Threading.Thread.Sleep(15); }
    }
    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles();
        var state = new InstallState(true);
        Check(!state.Begin(false) && state.Phase == InstallPhase.Confirmation, "uninstall waits for confirmation click");
        Check(state.Begin(true), "confirmation click accepted");
        for (int i=0;i<5;i++) Check(!state.Tick(true), "must wait while PS runs");
        Check(!state.Tick(false), "first quiet tick must not start");
        Check(!state.Tick(true), "restart resets quiet interval");
        Check(!state.Tick(false) && state.Tick(false), "start after stable exit");
        Check(!state.Tick(false), "backend starts only once");
        Check(!state.Cancel(), "cannot cancel a transaction");
        state.Complete(false);
        Check(state.Phase == InstallPhase.Failed, "failed outcome preserved");
        var cancel = new InstallState(false);
        Check(cancel.Begin(true) && cancel.Cancel(), "cancel waiting");
        Check(!cancel.Tick(false) && !cancel.Tick(false), "cancel never starts backend");
        var install = new InstallState(false);
        Check(install.Begin(true) && !install.Tick(false) && install.Tick(false), "install when PS closed");
        install.Complete(true);
        Check(install.Phase == InstallPhase.Done, "success state");
        using (var form = new InstallerForm(true, delegate { return true; }, delegate(Action<string> log) { throw new Exception("must not execute"); })) {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-30000, -30000);
            form.Opacity = 0;
            form.Show();
            Application.DoEvents();
            Check(form.ConfirmButton.Enabled, "confirmation button enabled without input");
            Pump(1100);
            Check(form.State.Phase == InstallPhase.Confirmation, "opening uninstall does not start it");
            using (var bmp = new Bitmap(form.Width, form.Height)) {
                form.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                bmp.Save(Path.Combine(args[0], "uninstall-preview.png"));
            }
            form.ConfirmButton.PerformClick();
            Check(form.State.Phase == InstallPhase.Waiting, "single confirmation click starts uninstall waiting");
            form.CancelWaiting();
        }
        using (var form = new InstallerForm(false, delegate { return true; }, delegate(Action<string> log) { throw new Exception("must not execute"); })) {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-30000, -30000);
            form.Opacity = 0;
            form.Show();
            Application.DoEvents();
            form.StartWaiting();
            using (var bmp = new Bitmap(form.Width, form.Height)) {
                form.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                bmp.Save(Path.Combine(args[0], "install-preview.png"));
            }
            form.CancelWaiting();
            Check(form.State.Phase == InstallPhase.Canceled, "UI cancellation");
        }
        bool psRunning = true;
        int calls = 0;
        using (var form = new InstallerForm(false, delegate { return psRunning; }, delegate(Action<string> log) { calls++; return Task.FromResult(0); })) {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-30000, -30000);
            form.Opacity = 0;
            form.Show();
            Pump(2300);
            Check(calls == 0 && form.State.Phase == InstallPhase.Waiting, "real timer waits for PS");
            psRunning = false;
            Pump(2600);
            Check(calls == 1 && form.State.Phase == InstallPhase.Done, "real timer dispatches exactly once after exit");
            form.Close();
        }
        Console.WriteLine("等待、退出稳定期、取消、重复启动保护、卸载确认、中文界面：通过");
        return 0;
    }
}
