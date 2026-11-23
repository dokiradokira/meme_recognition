using System;
using System.IO;
using System.Media;
namespace CongYou {
    internal sealed class Audio : IDisposable {
        readonly MemoryStream drink,mask;
        readonly SoundPlayer player=new SoundPlayer();
        public Audio() { drink=Score(true); mask=Score(false); }
        public void Play(Effect effect) {
            var wave=effect==Effect.Drink?drink:mask;
            wave.Position=0; player.Stream=wave; player.Play();
        }
        public void Stop() { player.Stop(); }
        static double Hit(double t,double at,double hz,double decay,double sweep) {
            double d=t-at;
            return d<0 ? 0 : Math.Min(d*220,1)*Math.Exp(-d*decay)*Math.Sin(2*Math.PI*(hz*d+sweep*(1-Math.Exp(-8*d))/8));
        }
        static MemoryStream Score(bool ad) {
            const int rate=22050;
            int n=(int)(rate*(ad?5.0:3.2));
            var stream=new MemoryStream(44+2*n);
            using(var w=new BinaryWriter(stream,System.Text.Encoding.ASCII,true)) {
                w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); w.Write(36+2*n);
                w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); w.Write(16);
                w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate*2);
                w.Write((short)2); w.Write((short)16);
                w.Write(System.Text.Encoding.ASCII.GetBytes("data")); w.Write(n*2);
                for(int i=0;i<n;i++) {
                    double t=(double)i/rate,v;
                    if(ad) {
                        v=.26*Hit(t,.05,392,8,60)+.28*Hit(t,.33,523,7,40)+.26*Hit(t,.61,659,7,30);
                        for(int j=0;j<3;j++) {
                            double at=.95+j*.95;
                            v+=.65*Hit(t,at,72,8,185)+.30*Hit(t,at+.14,523+j*110,9,45);
                        }
                        v+=.34*Hit(t,3.82,523,4,0)+.30*Hit(t,4.03,784,4,0);
                    } else v=.2*Hit(t,.03,180,4,-45)+.63*Hit(t,.74,57,3,160)+.34*Hit(t,1.65,84,5,240);
                    w.Write((short)(Math.Max(-1,Math.Min(1,v))*22000));
                }
            }
            stream.Position=0; return stream;
        }
        public void Dispose() { player.Stop(); player.Dispose(); drink.Dispose(); mask.Dispose(); }
    }
}
