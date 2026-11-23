using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CongYou {
    internal interface IPoseBackend : IDisposable {
        Task Initialize();
        Task<PoseFrame> Analyze(Bitmap frame, double time);
    }

    internal sealed class PosePoint {
        public float x { get; set; }
        public float y { get; set; }
        public float visibility { get; set; }
    }

    internal sealed class PoseFrame {
        public string kind { get; set; }
        public string action { get; set; }
        public string error { get; set; }
        public int id { get; set; }
        public double inferenceMs { get; set; }
        public PosePoint[] points { get; set; }
    }

    internal sealed class WebPoseBackend : IPoseBackend {
        const string Host = "pose.congyou.local";
        const string Entry = "https://" + Host + "/index.html";
        readonly WebView2 view;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly TaskCompletionSource<bool> ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        TaskCompletionSource<PoseFrame> pending;
        int frameId;
        bool disposed;

        public WebPoseBackend(Control owner) {
            view = new WebView2 { Size = new Size(1, 1), Location = new Point(-2, -2), TabStop = false };
            owner.Controls.Add(view);
            view.SendToBack();
        }

        public async Task Initialize() {
            var folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pose-engine");
            if (!File.Exists(Path.Combine(folder, "index.html"))) throw new FileNotFoundException("Missing pose engine.");
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CongYou", "PoseWebView");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile);
            if (disposed) throw new ObjectDisposedException("pose engine");
            await Wait(view.EnsureCoreWebView2Async(environment), 12000);
            if (disposed) throw new ObjectDisposedException("pose engine");
            var core = view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.SetVirtualHostNameToFolderMapping(Host, folder, CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += (sender, args) => { if (args.Uri != Entry) args.Cancel = true; };
            core.NewWindowRequested += (sender, args) => { args.Handled = true; };
            core.PermissionRequested += (sender, args) => { args.State = CoreWebView2PermissionState.Deny; };
            core.WebMessageReceived += Receive;
            core.ProcessFailed += (sender, args) => Fail("Pose renderer stopped.");
            core.Navigate(Entry);
            await Wait(ready.Task, 12000);
        }

        public async Task<PoseFrame> Analyze(Bitmap frame, double time) {
            if (disposed) throw new ObjectDisposedException("pose engine");
            if (pending != null) throw new InvalidOperationException("Only one pose frame may be in flight.");
            var response = new TaskCompletionSource<PoseFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending = response;
            try {
                var id = ++frameId;
                var jpeg = await Task.Run(() => Encode(frame));
                if (disposed) throw new ObjectDisposedException("pose engine");
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { id, time = time * 1000, jpeg }));
                await Wait(response.Task, 3000);
                return await response.Task;
            } finally {
                pending = null;
            }
        }

        static string Encode(Bitmap frame) {
            using (var buffer = new MemoryStream()) {
                frame.Save(buffer, ImageFormat.Jpeg);
                return Convert.ToBase64String(buffer.GetBuffer(), 0, (int)buffer.Length);
            }
        }

        static async Task Wait(Task task, int milliseconds) {
            if (await Task.WhenAny(task, Task.Delay(milliseconds)) != task) throw new TimeoutException("Pose engine timed out.");
            await task;
        }

        void Receive(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
            if (disposed || args.Source != Entry) return;
            try {
                var result = json.Deserialize<PoseFrame>(args.WebMessageAsJson);
                if (result.kind == "ready") ready.TrySetResult(true);
                else if (result.kind == "frame" && result.id == frameId && pending != null) pending.TrySetResult(result);
                else if (result.kind == "error") Fail(result.error);
            } catch (Exception error) {
                Fail(error.Message);
            }
        }

        void Fail(string message) {
            Trace.WriteLine(message);
            var error = new InvalidOperationException(message);
            ready.TrySetException(error);
            if (pending != null) pending.TrySetException(error);
            else if (ready.Task.Status == TaskStatus.RanToCompletion) view.Dispose();
        }

        public void Dispose() {
            if (disposed) return;
            disposed = true;
            ready.TrySetCanceled();
            if (pending != null) pending.TrySetCanceled();
            view.Dispose();
        }
    }
}
