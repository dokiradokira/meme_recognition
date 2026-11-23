using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;

namespace CongYou {
    internal sealed class Shot : IDisposable {
        public readonly Bitmap Image;
        public readonly double Time;
        public readonly RectangleF Face;
        public Shot(Bitmap image, double time, Rectangle face,int sampleHeight) {
            Image=new Bitmap(image,Math.Min(640,image.Width),Math.Max(1,image.Height*Math.Min(640,image.Width)/image.Width));
            Time=time;
            Face=new RectangleF(face.X/(float)Sample.Width,face.Y/(float)sampleHeight,face.Width/(float)Sample.Width,face.Height/(float)sampleHeight);
        }
        public void Dispose() { Image.Dispose(); }
    }
    internal sealed class Cut : IDisposable {
        public readonly Effect Kind;
        public readonly double Start,Contact;
        public double Duration { get { return Kind==Effect.Drink ? 5.0 : 3.2; } }
        public readonly Shot Before;
        public Shot After { get;private set; }
        readonly List<Shot> history;
        static Shot Closest(List<Shot> list,double t) { return list.OrderBy(s=>Math.Abs(s.Time-t)).First(); }
        public Cut(Trigger trigger,List<Shot> shots,double start) {
            Kind=trigger.Kind; Start=start; Contact=trigger.After; history=shots;
            Before=Closest(shots,trigger.Before); After=Closest(shots,trigger.After);
        }
        public void Append(Shot shot) {
            history.Add(shot);
            if(Kind==Effect.Mask) After=shot;
        }
        public void Dispose() { foreach(var shot in history) shot.Dispose(); history.Clear(); }
        static void FillPhoto(Graphics g,Rectangle r,Shot shot,double zoom,int shake) {
            float w=shot.Image.Width,h=shot.Image.Height;
            float cw=w,ch=cw*r.Height/r.Width;
            if(ch>h) { ch=h; cw=ch*r.Width/r.Height; }
            cw/=(float)zoom; ch/=(float)zoom;
            float cx=w*(shot.Face.X+shot.Face.Width*.5f),cy=h*(shot.Face.Y+shot.Face.Height*.58f);
            float x=Math.Max(0,Math.Min(w-cw,cx-cw/2+shake)),y=Math.Max(0,Math.Min(h-ch,cy-ch/2-shake/2));
            g.DrawImage(shot.Image,(RectangleF)r,new RectangleF(x,y,cw,ch),GraphicsUnit.Pixel);
        }
        public static void Caption(Graphics g,string msg,Rectangle r,float size,Color ink) {
            using(var font=new Font("Microsoft JhengHei",size,FontStyle.Bold,GraphicsUnit.Pixel))
            using(var brush=new SolidBrush(ink))
            using(var format=new StringFormat { Alignment=StringAlignment.Center,LineAlignment=StringAlignment.Center }) {
                g.DrawString(msg,font,Brushes.Black,new Rectangle(r.X+2,r.Y+2,r.Width,r.Height),format);
                g.DrawString(msg,font,brush,r,format);
            }
        }
        public void Draw(Graphics g,Rectangle r,double now) {
            double t=Math.Max(0,now-Start);
            var state=g.Save(); g.SetClip(r);
            try {
                if(Kind==Effect.Mask) {
                    int shake=t>1.65?(int)(Math.Sin(t*74)*Math.Exp(-4*(t-1.65))*16):0;
                    FillPhoto(g,r,t<1.65?Before:After,t<1.65?1.12:1.26,shake);
                    if(t>=.74 && t<1.65) {
                        using(var tint=new SolidBrush(Color.FromArgb(146,20,8,12))) g.FillRectangle(tint,r);
                        Caption(g,"WASTED",r,r.Height*.30f,Color.FromArgb(255,77,72));
                    }
                } else {
                    Shot shot=After; double zoom=1.05+Math.Min(1,t)*.28;
                    string msg="各位，注意看。"; Color ink=Color.White;
                    if(t>=.95 && t<3.8) {
                        double phase=(t-.95)%.95;
                        shot=Closest(history,Contact-.70+phase); zoom=1.25+.42*phase;
                        msg="他真的喝了！"; ink=Color.FromArgb(233,255,96);
                    } else if(t>=3.8) {
                        shot=Closest(history,Contact-.33+(t-3.8)*.35);
                        msg="經慢動作確認，他喝了。"; zoom=1.40;
                    }
                    FillPhoto(g,r,shot,zoom,0);
                    var strip=new Rectangle(r.X,r.Bottom-r.Height/4,r.Width,r.Height/4);
                    using(var shade=new SolidBrush(Color.FromArgb(190,12,15,18))) g.FillRectangle(shade,strip);
                    Caption(g,msg,strip,r.Height*(t>=.95 && t<3.8?.145f:.10f),ink);
                }
            } finally { g.Restore(state); }
        }
    }
}
