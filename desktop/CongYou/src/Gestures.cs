using System;
namespace CongYou {
    internal enum Effect { None, Drink, Mask }
    internal sealed class Trigger {
        public Effect Kind;
        public double Before,After;
        public Trigger(Effect kind,double before,double after) { Kind=kind; Before=before; After=after; }
    }
    internal sealed class Gestures {
        double bareSince=-1,maskSince=-1,contactSince=-1,lastLift=-100,maskedShot=-1;
        bool drinkArmed,maskArmed;
        public void Resume(bool bare,bool masked,double last) {
            Reset(); drinkArmed=bare; maskArmed=masked; maskedShot=last;
        }
        public Trigger Step(double now,Signals s) {
            if(s.Bare) {
                if(bareSince<0) bareSince=now;
                if(maskArmed && now-bareSince>=.24) {
                    var shot=maskedShot; Reset(); return new Trigger(Effect.Mask,shot,now);
                }
                if(now-bareSince>=.32) { drinkArmed=true; }
            } else bareSince=-1;
            if(s.Rising && drinkArmed && contactSince<0) lastLift=now;
            // Broad coverage on both cheeks looks like putting on a mask. Give that state time to settle.
            if(s.Mask) contactSince=-1;
            if(s.Contact && !s.Mask && drinkArmed && !maskArmed && now-lastLift<1.05 && contactSince<0) contactSince=now;
            if(contactSince>=0) {
                if(s.Contact && now-contactSince>=.32) {
                    var shot=now; Reset(); return new Trigger(Effect.Drink,shot,now);
                }
                if(!s.Contact) contactSince=-1;
            }
            if(s.Mask) {
                if(maskSince<0) maskSince=now;
                if(now-maskSince>=.72) { maskArmed=true; drinkArmed=false; maskedShot=now; }
            } else maskSince=-1;
            if(maskArmed && now-maskedShot>1.8) Reset();
            return null;
        }
        public void Reset() {
            bareSince=maskSince=contactSince=maskedShot=-1;
            lastLift=-100; drinkArmed=maskArmed=false;
        }
    }
}
