using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Windows.Devices.Enumeration;

namespace CongYou {
    internal sealed class ScreenView : Control {
        public Bitmap Live;
        public Session Session;
        public PoseDisplay Pose;
        public bool ShowSkeleton;
        public double Now;
        public string Idle="選擇鏡頭，開始檢測";
        Rectangle videoArea;
        Point? drag;
        Point end;
        public event Action<Rectangle> FaceSelected;
        public ScreenView() { DoubleBuffered=true; BackColor=Color.FromArgb(18,21,23); Dock=DockStyle.Fill; }
        public void SetLive(Bitmap frame) {
            var old=Live; Live=frame; if(old!=null) old.Dispose();
            if(frame==null) { drag=null; videoArea=Rectangle.Empty; }
        }
        Rectangle Selection() {
            var a=drag.Value;
            return Rectangle.Intersect(videoArea,Rectangle.FromLTRB(Math.Min(a.X,end.X),Math.Min(a.Y,end.Y),Math.Max(a.X,end.X),Math.Max(a.Y,end.Y)));
        }
        protected override void OnMouseDown(MouseEventArgs e) {
            if(e.Button==MouseButtons.Left && Live!=null && videoArea.Contains(e.Location) && Session.Playing==null) {
                drag=end=e.Location; Capture=true;
            }
        }
        protected override void OnMouseMove(MouseEventArgs e) { if(drag.HasValue) { end=e.Location; Invalidate(); } }
        protected override void OnMouseUp(MouseEventArgs e) {
            if(!drag.HasValue || Live==null) return;
            end=e.Location; var r=Selection(); drag=null; Capture=false; Invalidate();
            float k=Sample.Width/(float)videoArea.Width;
            var box=Rectangle.Round(new RectangleF((r.X-videoArea.X)*k,(r.Y-videoArea.Y)*k,r.Width*k,r.Height*k));
            if(box.Width>=24 && box.Height>=24 && FaceSelected!=null) FaceSelected(box);
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            var g=e.Graphics; g.InterpolationMode=InterpolationMode.HighQualityBilinear;
            if(Width<2 || Height<2) return;
            if(Live==null) { Cut.Caption(g,Idle,ClientRectangle,Math.Max(16,Math.Min(26,Width/32)),Color.Gainsboro); return; }
            double scale=Math.Min(Width/(double)Live.Width,Height/(double)Live.Height);
            int w=Math.Max(1,(int)(Live.Width*scale)),h=Math.Max(1,(int)(Live.Height*scale));
            var area=new Rectangle((Width-w)/2,(Height-h)/2,w,h);
            videoArea=area;
            g.DrawImage(Live,area);
            if(ShowSkeleton && Pose!=null) Pose.DrawSkeleton(g,area);
            int iw=Math.Max(2,w*37/100),margin=Math.Max(4,w/60);
            var inset=new Rectangle(area.Right-iw-margin,area.Y+margin,iw,Math.Max(2,iw*9/16));
            if(Session!=null && Session.Playing!=null) Session.Playing.Draw(g,inset,Now);
            else if(Pose!=null && Pose.HasMeme) Pose.DrawMeme(g,inset,Now);
            else {
                g.FillRectangle(Brushes.Black,inset);
                Cut.Caption(g,"檢測中",inset,Math.Max(10,iw*.063f),Color.Silver);
            }
            using(var pen=new Pen(Color.FromArgb(210,226,152),2)) g.DrawRectangle(pen,inset);
            if(drag.HasValue) g.DrawRectangle(Pens.Gold,Selection());
        }
    }
    internal sealed class MainForm : Form {
        readonly ComboBox cameras=new ComboBox { DropDownStyle=ComboBoxStyle.DropDownList,Width=205 };
        readonly Button toggle=new Button { Text="開啟鏡頭",AutoSize=true };
        readonly CheckBox mute=new CheckBox { Text="靜音",AutoSize=true,ForeColor=Color.White };
        readonly Label status=new Label { AutoEllipsis=true,Dock=DockStyle.Bottom,Height=34,Padding=new Padding(12,6,0,0),ForeColor=Color.Gainsboro };
        readonly ScreenView screen=new ScreenView();
        readonly Timer clock=new Timer { Interval=30 };
        readonly Stopwatch watch=Stopwatch.StartNew();
        readonly Audio audio=new Audio();
        DeviceInformation[] devices=new DeviceInformation[0];
        Camera camera;
        FaceLocator locator;
        Session session;
        IPoseBackend poseBackend;
        PoseDisplay poseDisplay;
        readonly ToolStripMenuItem skeletonToggle=new ToolStripMenuItem("顯示骨架") { CheckOnClick=true, ShortcutKeys=Keys.F2 };
        readonly ToolStripMenuItem freezeToggle=new ToolStripMenuItem("本人定格") { CheckOnClick=true, ShortcutKeys=Keys.F3 };
        int generation;
        bool analyzing,poseReady,poseBusy,poseFailed;
        double analysisAt,lastFrame,poseAt;
        double Now { get { return watch.Elapsed.TotalSeconds; } }
        public MainForm() {
            Text="从游｜鏡頭放映室"; ClientSize=new Size(1040,680); MinimumSize=new Size(660,460);
            Font=new Font("Microsoft JhengHei",10); BackColor=Color.FromArgb(26,30,32);
            var bar=new FlowLayoutPanel { Dock=DockStyle.Top,Height=54,Padding=new Padding(10,8,4,0),WrapContents=false };
            var title=new Label { Text="从游  /  鏡頭放映室",AutoSize=true,Padding=new Padding(0,5,18,0),ForeColor=Color.FromArgb(222,244,143) };
            mute.Margin=new Padding(14,6,0,0); bar.Controls.AddRange(new Control[]{title,cameras,toggle,mute});
            Controls.Add(screen); Controls.Add(status); Controls.Add(bar);
            var options=new ContextMenuStrip();
            options.Items.AddRange(new ToolStripItem[]{skeletonToggle,freezeToggle});
            status.ContextMenuStrip=options;
            skeletonToggle.CheckedChanged+=(s,e)=>{ screen.ShowSkeleton=skeletonToggle.Checked; screen.Invalidate(); };
            freezeToggle.CheckedChanged+=(s,e)=>{
                if(!freezeToggle.Checked && poseDisplay!=null) { poseDisplay.ClearStill(); screen.Invalidate(); }
            };
            Shown+=async (s,e)=>await RefreshDevices();
            toggle.Click+=async (s,e)=>{ if(camera!=null) Stop("鏡頭已關閉"); else if(devices.Length==0) await RefreshDevices(); else await Start(); };
            mute.CheckedChanged+=(s,e)=>{ if(mute.Checked) audio.Stop(); };
            screen.FaceSelected+=box=>{
                if(locator!=null && screen.Live!=null && session.Playing==null)
                    locator.SetAnchor(new Sample(screen.Live),box,Now);
            };
            clock.Tick+=(s,e)=>Tick();
            FormClosed+=(s,e)=>{ Stop(""); audio.Dispose(); clock.Dispose(); options.Dispose(); };
        }
        protected override bool ProcessCmdKey(ref Message message, Keys keyData) {
            if(keyData==Keys.F2) { skeletonToggle.Checked=!skeletonToggle.Checked; return true; }
            if(keyData==Keys.F3) { freezeToggle.Checked=!freezeToggle.Checked; return true; }
            return base.ProcessCmdKey(ref message,keyData);
        }
        async Task RefreshDevices() {
            toggle.Enabled=false;
            try {
                devices=(await DeviceInformation.FindAllAsync(DeviceClass.VideoCapture)).ToArray();
                if(IsDisposed) return;
                cameras.Items.Clear();
                cameras.Items.AddRange(devices.Select(d=>(object)d.Name).ToArray());
                if(devices.Length>0) {
                    cameras.SelectedIndex=0; screen.Idle="選擇鏡頭，開始檢測"; status.Text="就緒"; toggle.Text="開啟鏡頭";
                } else { screen.Idle="未找到鏡頭"; status.Text="接上攝影機後，點選重新搜尋。"; toggle.Text="重新搜尋"; }
            } catch(Exception ex) { if(!IsDisposed) { status.Text=ex.Message; toggle.Text="重新搜尋"; } }
            finally { if(!IsDisposed) { toggle.Enabled=true; screen.Invalidate(); } }
        }
        async Task Start() {
            int id=++generation; toggle.Enabled=false; cameras.Enabled=false; status.Text="正在開啟鏡頭…";
            var candidate=new Camera();
            try {
                await candidate.Open(devices[cameras.SelectedIndex].Id);
                var tracking=new FaceLocator(); await tracking.Initialize();
                if(id!=generation) return;
                camera=candidate; candidate=null; locator=tracking; session=new Session(); screen.Session=session;
                toggle.Text="關閉鏡頭"; lastFrame=Now; analysisAt=-1; clock.Start();
                StartPose(id);
            } catch(Exception ex) {
                if(id==generation) Stop("無法啟動。請確認相機權限及占用狀態。 "+ex.Message);
            } finally {
                if(candidate!=null) candidate.Dispose();
                if(!IsDisposed) toggle.Enabled=true;
            }
        }
        void Stop(string message) {
            generation++; clock.Stop(); analyzing=false; audio.Stop();
            poseReady=poseBusy=poseFailed=false;
            if(poseBackend!=null) { poseBackend.Dispose(); poseBackend=null; }
            if(poseDisplay!=null) { poseDisplay.Dispose(); poseDisplay=null; }
            screen.Pose=null;
            if(camera!=null) { camera.Dispose(); camera=null; }
            if(session!=null) { session.Dispose(); session=null; }
            screen.Session=null; screen.SetLive(null); screen.Invalidate();
            cameras.Enabled=true; toggle.Text="開啟鏡頭"; status.Text=message;
        }

        async void StartPose(int id) {
            poseAt=-1;
            poseDisplay=new PoseDisplay(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"pose-assets"));
            screen.Pose=poseDisplay;
            try {
                poseBackend=new WebPoseBackend(this);
                await poseBackend.Initialize();
                if(id==generation) poseReady=true;
            } catch(Exception error) {
                if(id==generation) DisablePose(error);
            }
        }

        void DisablePose(Exception error) {
            Trace.WriteLine(error);
            poseReady=false; poseFailed=true;
            if(poseBackend!=null) { poseBackend.Dispose(); poseBackend=null; }
            poseDisplay.Dispose();
            screen.Invalidate();
        }

        async void AnalyzePose(Bitmap frame, double time, int id) {
            if(!poseReady || poseBusy || time-poseAt<.065) return;
            poseAt=time; poseBusy=true;
            var ticket=poseDisplay.Ticket(session.Playing!=null);
            try {
                using(var snapshot=(Bitmap)frame.Clone()) {
                    var result=await poseBackend.Analyze(snapshot,time);
                    if(id!=generation || Now-time>.45) return;
                    poseDisplay.Points=result.points;
                    if(result.points==null || result.points.Length==0) poseDisplay.ClearStill();
                    if(result.action!=null) poseDisplay.Show(ticket,result.action,snapshot,freezeToggle.Checked,Now,
                        freezeToggle.Checked && PoseDisplay.AnimationsEnabled());
                    screen.Invalidate();
                }
            } catch(Exception error) {
                if(id==generation) DisablePose(error);
            } finally {
                if(id==generation) poseBusy=false;
            }
        }

        async void Tick() {
            int id=generation;
            try {
                double time=Now; session.Advance(time); screen.Now=time;
                if(poseDisplay!=null) {
                    poseDisplay.Advance(time);
                    if(time-poseAt>.45) poseDisplay.Points=null;
                }
                var frame=camera.Next();
                if(frame==null) {
                    if(time-lastFrame>4) Stop("鏡頭已中斷，請重新連接並開啟。");
                    else screen.Invalidate();
                    return;
                }
                lastFrame=time; screen.SetLive(frame); screen.Invalidate();
                AnalyzePose(frame,time,id);
                if(analyzing || time-analysisAt<.075) return;
                analyzing=true; analysisAt=time;
                try {
                    using(var snapshot=(Bitmap)frame.Clone()) {
                        var sample=new Sample(snapshot);
                        var face=await locator.Locate(sample,time);
                        if(id!=generation || Now-time>.45) return;
                        var effect=session.Observe(snapshot,sample,face,time);
                        if(effect!=Effect.None) {
                            if(poseDisplay!=null) poseDisplay.BeginOriginal();
                            if(!mute.Checked) audio.Play(effect);
                        }
                        status.Text=session.Playing==null?session.Hint+(poseFailed?"  /  姿勢辨識無法啟動":""):
                            (session.Playing.Kind==Effect.Drink?"放映中  /  他真的喝了！":"放映中  /  WASTED");
                    }
                } finally { if(id==generation) analyzing=false; }
            } catch(Exception ex) { if(id==generation) Stop("鏡頭工作階段已停止。 "+ex.Message); }
        }
    }
    internal static class Program {
        [STAThread]
        static void Main() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
