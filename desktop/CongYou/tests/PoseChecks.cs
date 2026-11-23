using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace CongYou {
    internal static class PoseChecks {
        static void Assert(bool condition, string label) {
            if (!condition) throw new Exception(label);
            Console.WriteLine("PASS " + label);
        }

        public static void Run() {
            var directory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "pose-assets");
            using (var display = new PoseDisplay(directory))
            using (var still = new Bitmap(640,480))
            using (var render = new Bitmap(800,600))
            using (var graphics = Graphics.FromImage(render)) {
                var actions = new[] { "hands-up","arms-out","wave","arms-crossed","hand-on-chin" };
                var captions = new[] { "我投降","我宣布个事","嗨，看到我了吗","这事我不同意","让我想想" };
                for (int i = 0; i < actions.Length; i++) {
                    Assert(display.Show(display.Ticket(false),actions[i],still,true,i,false) &&
                        display.HasStill && display.Caption == captions[i], "caption and still for " + actions[i]);
                    display.DrawMeme(graphics,new Rectangle(430,20,320,180),i);
                }
                display.Advance(5.1);
                Assert(!display.HasStill && display.HasMeme,"one-second still returns to the meme");
                int beforeOriginal = display.Ticket(false);
                display.BeginOriginal();
                Assert(!display.HasMeme && !display.HasStill,"an original cut clears the meme and still");
                Assert(!display.Show(beforeOriginal,"hands-up",still,true,6,true) &&
                    !display.Show(display.Ticket(true),"arms-out",still,true,6,true),
                    "delayed results cannot surface during or after the original cut");
                Assert(display.Show(display.Ticket(false),"wave",null,true,7,true) &&
                    !display.HasStill && display.HasMeme,"new meme accepted after the cut, with capture-failure fallback");
                Assert(display.Show(display.Ticket(false),"arms-crossed",still,false,8,false) &&
                    !display.HasStill && display.Caption == captions[3], "freeze is optional and new memes replace the old ones");
                var point = new PosePoint { x=.25f,y=.75f,visibility=1 };
                var bounds = new Rectangle(40,60,640,480);
                var pixel = PoseDisplay.Project(point,bounds);
                display.Points = new[] { point };
                display.DrawSkeleton(graphics,bounds);
                Assert(pixel == new PointF(200,420) && render.GetPixel(200,420).G == 255,
                    "mirrored landmark draws once in the letterboxed video area");
                display.Dispose();
                Assert(!display.HasMeme && !display.HasStill && display.Points == null,"pose session releases still, meme and landmarks");
            }
            using (var main = new MainForm()) {
                var bar = main.Controls.OfType<FlowLayoutPanel>().Single();
                var status = main.Controls.OfType<Label>().Single();
                Assert(bar.Controls.Count == 4 && bar.Controls[1] is ComboBox &&
                    bar.Controls[2].Text == "開啟鏡頭" && bar.Controls[3].Text == "靜音",
                    "original toolbar and control order");
                var shortcuts = status.ContextMenuStrip.Items.OfType<ToolStripMenuItem>().ToArray();
                Assert(shortcuts.Select(item => item.ShortcutKeys).SequenceEqual(new[] { Keys.F2,Keys.F3 }) &&
                    shortcuts.All(item => !item.Checked),"pose controls stay in status menu and default off");
            }
            NativeEngine();
        }

        static void NativeEngine() {
            Exception failure = null;
            using (var form = new Form { Opacity=0, ShowInTaskbar=false })
            using (var timer = new Timer { Interval=30000 }) {
                timer.Tick += (sender,args) => { failure=new TimeoutException("Native pose smoke test timed out."); form.Close(); };
                form.Shown += async (sender,args) => {
                    try {
                        using (var backend = new WebPoseBackend(form))
                        using (var blank = new Bitmap(640,480)) {
                            await backend.Initialize();
                            var clock = Stopwatch.StartNew();
                            for (int i = 0; i < 3; i++) {
                                var result = await backend.Analyze(blank,i*.08);
                                Assert(result.points != null && result.points.Length == 0 && result.action == null,
                                    "native bridge and real model returned empty landmarks");
                                Console.WriteLine("Pose inference: {0:F1} ms, cumulative JPEG round trips: {1:F1} ms",
                                    result.inferenceMs,clock.Elapsed.TotalMilliseconds);
                            }
                        }
                    } catch (Exception error) { failure=error; }
                    finally { if (!form.IsDisposed) form.Close(); }
                };
                timer.Start();
                Application.Run(form);
            }
            if (failure != null) throw failure;
        }
    }
}
