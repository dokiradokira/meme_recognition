using System;
using System.Collections.Generic;
using System.Drawing;

namespace CongYou {
    internal sealed class Session : IDisposable {
        List<Shot> shots=new List<Shot>();
        readonly Gestures gestures=new Gestures();
        Trigger pending;
        Features features=new Features();
        public Cut Playing {get;private set;}
        public string Hint="請一人面向鏡頭";
        double last=-100,bareSince=-1,maskSince=-1;
        bool heldContainer,tailAvailable;

        void ClearShots() { foreach(var shot in shots) shot.Dispose(); shots.Clear(); }
        void BreakTrack() {
            gestures.Reset(); pending=null; features=new Features(); last=-100; bareSince=maskSince=-1;
            heldContainer=false; ClearShots();
            tailAvailable=false;
        }
        public void Advance(double now) {
            if(Playing!=null && now-Playing.Start>=Playing.Duration) {
                // An action that started during the cut must not surface after it.
                Playing.Dispose(); Playing=null;
                gestures.Resume(now-last<.35 && bareSince>=0 && last-bareSince>=.32,
                    now-last<.35 && !heldContainer && maskSince>=0 && last-maskSince>=.72,last);
            }
        }
        public Effect Observe(Bitmap image,Sample sample,Rectangle face,double time) {
            Advance(time);
            if(face.Width<24 || face.Height<24) { BreakTrack(); Hint="請一人正面入鏡；戴罩時若持續找不到臉，可在主畫面拖曳框選整張臉。"; return Effect.None; }
            if(time-last>.48 || !features.Continues(sample,face)) BreakTrack();
            last=time;
            var signal=features.Measure(sample,face);
            bareSince=signal.Bare?(bareSince<0?time:bareSince):-1;
            maskSince=signal.Mask?(maskSince<0?time:maskSince):-1;
            if(bareSince>=0 && time-bareSince>=.25) heldContainer=false;
            shots.Add(new Shot(image,time,face,sample.Height));
            while(shots.Count>1 && time-shots[0].Time>3.1) { shots[0].Dispose(); shots.RemoveAt(0); }
            if(Playing!=null) {
                double dt=time-Playing.Contact;
                if(tailAvailable && (Playing.Kind==Effect.Drink ? dt<=.9 : signal.Bare && dt<=.25))
                    Playing.Append(new Shot(image,time,face,sample.Height));
                return Effect.None;
            }
            if(heldContainer) { Hint="等待放下容器"; return Effect.None; }
            Hint=signal.Mask?"已看到口罩區域":"檢測中";
            var trigger=pending??gestures.Step(time,signal);
            if(trigger!=null) {
                // A sip uses the preceding second and the next 0.9 s; the first half is ready now.
                if(trigger.Kind==Effect.Drink && time-shots[0].Time<.9) { pending=trigger; return Effect.None; }
                pending=null;
                Playing=new Cut(trigger,shots,time); shots=new List<Shot>(); tailAvailable=true;
                heldContainer=trigger.Kind==Effect.Drink; return trigger.Kind;
            }
            return Effect.None;
        }
        public void Dispose() { if(Playing!=null) Playing.Dispose(); Playing=null; ClearShots(); }
    }
}
