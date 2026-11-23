using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.FaceAnalysis;

namespace CongYou {
    // All positions below are relative to the current face, including the area below the chin.
    internal sealed class Sample {
        public const int Width = 320;
        public readonly int Height;
        readonly byte[] bgra;
        public readonly byte[] Gray;
        public Sample(Bitmap image) {
            Height = Math.Max(1,image.Height * Width / image.Width);
            using (var small = new Bitmap(image,Width,Height)) {
                var data = small.LockBits(new Rectangle(0,0,Width,Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                bgra = new byte[Width*Height*4];
                try { Marshal.Copy(data.Scan0,bgra,0,bgra.Length); }
                finally { small.UnlockBits(data); }
            }
            Gray = new byte[Width*Height];
            for (int i=0;i<Gray.Length;i++) Gray[i]=(byte)((bgra[4*i]*29+bgra[4*i+1]*150+bgra[4*i+2]*77)>>8);
        }
        public Color At(Rectangle face,double x,double y) {
            int px=Math.Max(0,Math.Min(Width-1,(int)(face.X+face.Width*x)));
            int py=Math.Max(0,Math.Min(Height-1,(int)(face.Y+face.Height*y)));
            int i=(py*Width+px)*4;
            return Color.FromArgb(bgra[i+2],bgra[i+1],bgra[i]);
        }
        public static double Difference(Color a,Color b) {
            return (Math.Abs(a.R-b.R)+Math.Abs(a.G-b.G)+Math.Abs(a.B-b.B))/3.0;
        }
        public double EyeDifference(Rectangle face, Sample other,Rectangle previous) {
            double d=0;
            for (int y=0;y<4;y++) for (int x=0;x<12;x++) {
                double fx=.12+.068*x, fy=.19+.062*y;
                d+=Difference(At(face,fx,fy),other.At(previous,fx,fy));
            }
            return d/48;
        }
    }
    internal sealed class FaceLocator {
        FaceDetector detector;
        Sample anchor;
        Rectangle last,anchorFace;
        double lastSeen;
        bool manual;
        public void SetAnchor(Sample s,Rectangle box,double time) {
            anchor=s; last=anchorFace=box; lastSeen=time; manual=true;
        }
        public async Task Initialize() {
            detector=await FaceDetector.CreateAsync();
        }
        public async Task<Rectangle> Locate(Sample s,double now) {
            using(var gray=SoftwareBitmap.CreateCopyFromBuffer(s.Gray.AsBuffer(),BitmapPixelFormat.Gray8,Sample.Width,s.Height)) {
                var faces=await detector.DetectFacesAsync(gray);
                if(faces.Count>1) { anchor=null; manual=false; last=Rectangle.Empty; return last; }
                if(faces.Count==1) {
                    var b=faces[0].FaceBox;
                    last=new Rectangle((int)b.X,(int)b.Y,(int)b.Width,(int)b.Height);
                    anchor=s; anchorFace=last; lastSeen=now; manual=false;
                    return last;
                }
            }
            // A cup or a mask can briefly hide the features used by the face detector.
            if(anchor==null || (!manual && now-lastSeen>1.4)) return Rectangle.Empty;
            var best=last; double error=double.MaxValue;
            int step=Math.Max(1,last.Width/18);
            for(int y=-2;y<=2;y++) for(int x=-2;x<=2;x++) {
                var box=last; box.Offset(x*step,y*step);
                if(box.X<0 || box.Y<0 || box.Right>Sample.Width || box.Bottom>s.Height) continue;
                double d=s.EyeDifference(box,anchor,anchorFace)+.4*(Math.Abs(x)+Math.Abs(y));
                if(d<error) { error=d; best=box; }
            }
            if(error>24) { manual=false; anchor=null; return Rectangle.Empty; }
            last=best; return best;
        }
    }
    internal sealed class Signals {
        public bool Mask, Contact, Rising, Bare;
    }
    internal sealed class Features {
        Sample previous;
        Rectangle oldFace;
        Color[] bareMouth;
        static Color[] Grid(Sample s,Rectangle f,double x0,double x1,double y0,double y1) {
            var colors=new Color[25];
            for(int y=0;y<5;y++) for(int x=0;x<5;x++)
                colors[y*5+x]=s.At(f,x0+(x1-x0)*x/4,y0+(y1-y0)*y/4);
            return colors;
        }
        static int Median(int[] values) { Array.Sort(values); return values[values.Length/2]; }
        static bool UnlikeSkin(Color c,Color skin) {
            int dr=c.R-skin.R, dg=c.G-skin.G, db=c.B-skin.B;
            return Math.Abs(dr-dg)>16 || Math.Abs(dr-db)>24 || Math.Abs(dr+dg+db)>151;
        }
        public bool Continues(Sample s,Rectangle f) {
            if(previous==null) return true;
            return Rectangle.Intersect(f,oldFace).Width>Math.Min(f.Width,oldFace.Width)*.48 &&
                Rectangle.Intersect(f,oldFace).Height>Math.Min(f.Height,oldFace.Height)*.48 &&
                s.EyeDifference(f,previous,oldFace)<41;
        }
        public Signals Measure(Sample s,Rectangle f) {
            var forehead=Grid(s,f,.32,.68,.11,.24);
            var temples=Grid(s,f,.12,.27,.37,.47).Concat(Grid(s,f,.73,.88,.37,.47));
            var skinPoints=forehead.Concat(temples).ToArray();
            var skin=Color.FromArgb(Median(skinPoints.Select(c=>(int)c.R).ToArray()),
                Median(skinPoints.Select(c=>(int)c.G).ToArray()),Median(skinPoints.Select(c=>(int)c.B).ToArray()));
            var mouth=Grid(s,f,.35,.65,.63,.79);
            int odd=mouth.Count(c=>UnlikeSkin(c,skin));
            int left=Grid(s,f,.17,.36,.55,.73).Count(c=>UnlikeSkin(c,skin));
            int right=Grid(s,f,.64,.83,.55,.73).Count(c=>UnlikeSkin(c,skin));
            var signal=new Signals();
            signal.Mask=odd>=19 && left>=16 && right>=16;
            int changed=bareMouth==null?0:mouth.Where((c,i)=>Sample.Difference(c,bareMouth[i])>32).Count();
            signal.Contact=odd>=13 || changed>=14;
            signal.Bare=odd<=10 && left<15 && right<15 && changed<=10;
            if(previous!=null) {
                int moving=0,rising=0;
                for(int y=0;y<4;y++) for(int x=0;x<8;x++) {
                    double fx=.04+x*.13,fy=.92+y*.13;
                    var color=s.At(f,fx,fy);
                    double change=Sample.Difference(color,previous.At(oldFace,fx,fy));
                    if(change<=24) continue;
                    moving++;
                    // Look below the changed patch in the older frame for the same moving surface.
                    for(int dy=1;dy<=4;dy++) {
                        double oldY=fy+dy*.105;
                        double match=Sample.Difference(color,previous.At(oldFace,fx,oldY));
                        if(match<change*.65 && match<30) { rising++; break; }
                    }
                }
                signal.Rising=moving>=5 && rising>=3;
            }
            if(signal.Bare) bareMouth=mouth;
            previous=s; oldFace=f;
            return signal;
        }
    }
}
