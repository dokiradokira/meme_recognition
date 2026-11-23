using System;
using System.Drawing;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows.Forms;
using Windows.Devices.Enumeration;
using Windows.Graphics.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
namespace CongYou {
    // Exercises the normal pixel -> observations -> edit -> renderer path with deterministic frames.
    internal sealed class Checks : IDisposable {
        readonly Session session=new Session();
        readonly Rectangle face=new Rectangle(110,28,84,90);
        double time;
        readonly List<Effect> fired=new List<Effect>();
        static void Assert(bool ok,string name) {
            if(!ok) throw new Exception(name);
            Console.WriteLine("PASS "+name);
        }
        Bitmap Frame(bool mask,int top,int x) {
            var b=new Bitmap(320,180);
            using(var g=Graphics.FromImage(b)) {
                g.Clear(Color.FromArgb(62,70,78));
                using(var skin=new SolidBrush(Color.FromArgb(182,135,107))) g.FillEllipse(skin,face);
                g.FillRectangle(Brushes.Black,132,59,12,3); g.FillRectangle(Brushes.Black,165,59,12,3);
                g.FillRectangle(Brushes.Brown,144,92,17,2);
                if(mask) g.FillRectangle(Brushes.LightBlue,119,74,68,30);
                if(top>=0) g.FillRectangle(Brushes.SteelBlue,x,top,32,59);
            }
            return b;
        }
        void Feed(int n,bool mask=false,int top=-1,int x=136,bool present=true) {
            for(int i=0;i<n;i++) using(var b=Frame(mask,top,x)) {
                time+=.1;
                var kind=session.Observe(b,new Sample(b),present?face:Rectangle.Empty,time);
                if(kind!=Effect.None) fired.Add(kind);
            }
        }
        void Lift(int x=136) {
            foreach(int top in new[]{160,143,125,109,95,84}) Feed(1,false,top,x);
            Feed(5,false,84,x);
        }
        void Render(double elapsed) {
            using(var b=new Bitmap(320,180)) using(var g=Graphics.FromImage(b)) {
                session.Playing.Draw(g,new Rectangle(0,0,320,180),session.Playing.Start+elapsed);
                if(b.GetPixel(170,100).A!=255) throw new Exception("empty render");
            }
        }
        void DrinkCheck() {
            Feed(18); Lift(192);
            Assert(fired.Count==0,"container beside face");
            Feed(15); Lift();
            Assert(fired.Count==1 && fired[0]==Effect.Drink,"lift and mouth contact");
            Render(.4);Render(2);Render(4.6);
            Feed(62,false,84); Feed(15);
            Assert(fired.Count==1,"held sip through playback and release");
            Lift(); Assert(fired.Count==2 && fired[1]==Effect.Drink,"second sip");
            Feed(10); Feed(12,true); Feed(45);
            Assert(fired.Count==2,"ignored mask removal during ad does not queue");
        }
        void MaskCheck() {
            Feed(12,true); Feed(6);
            Assert(fired.Count==1 && fired[0]==Effect.Mask,"mask removal");
            var cut=session.Playing;
            Assert(cut.Before.Image.GetPixel(142,88).B>170 && cut.After.Image.GetPixel(142,88).B<145,"masked and unmasked photos");
            Render(.1); Render(1.1); Render(2.1);
            Feed(40); Feed(12,true); Feed(3,false,-1,136,false); Feed(12);
            Assert(fired.Count==1,"track loss invalidates masked photo");
        }
        void MaskOnCheck() {
            Feed(18);
            foreach(int top in new[]{160,143,125,109}) Feed(1,false,top);
            Feed(15,true);
            Assert(fired.Count==0,"putting a mask on after a lift does not play a drink ad");
            Feed(6);
            Assert(fired.Count==1 && fired[0]==Effect.Mask,"removing newly fitted mask");
        }
        static void WindowCheck() {
            using(var form=new MainForm()) using(var timer=new Timer { Interval=100 }) {
                form.Opacity=0; form.ShowInTaskbar=false;
                bool ready=false; int ticks=0;
                timer.Tick+=(s,e)=>{
                    foreach(Control item in form.Controls) {
                        var label=item as Label;
                        if(label!=null && !String.IsNullOrEmpty(label.Text)) ready=true;
                    }
                    if(ready || ++ticks>80) form.Close();
                };
                timer.Start(); Application.Run(form);
                Assert(ready,"desktop startup and device-selection screen");
            }
        }
        static async Task NativeCheck() {
            var input=new byte[]{0,0,255,255,255,0,0,255};
            using(var native=SoftwareBitmap.CreateCopyFromBuffer(input.AsBuffer(),BitmapPixelFormat.Bgra8,2,1))
            using(var camera=new Camera())
            using(var mirrored=camera.CopyMirrored(native)) {
                Assert(mirrored.GetPixel(0,0).B==255 && mirrored.GetPixel(1,0).R==255,"camera pixel transfer and mirrored preview");
            }
            var locator=new FaceLocator(); await locator.Initialize();
            using(var b=new Bitmap(320,180)) {
                var box=await locator.Locate(new Sample(b),0);
                Assert(box.IsEmpty,"native face detector on blank input");
            }
            var devices=await DeviceInformation.FindAllAsync(DeviceClass.VideoCapture);
            Console.WriteLine("Camera devices reported: "+devices.Count);
        }
        [STAThread] static int Main() {
            try {
                using(var c=new Checks()) c.DrinkCheck();
                using(var c=new Checks()) c.MaskCheck();
                using(var c=new Checks()) c.MaskOnCheck();
                NativeCheck().GetAwaiter().GetResult();
                WindowCheck();
                PoseChecks.Run();
                return 0;
            } catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }
        public void Dispose() { session.Dispose(); }
    }
}
