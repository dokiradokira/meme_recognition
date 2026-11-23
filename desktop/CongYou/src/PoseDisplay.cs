using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace CongYou {
    internal sealed class MemeAsset {
        public string caption { get; set; }
        public string freezeCaption { get; set; }
        public string image { get; set; }
    }

    internal sealed class PoseDisplay : IDisposable {
        static readonly int[,] Bones = {
            {0,9},{0,10},{9,10},{0,11},{0,12},{11,12},{11,13},{12,14},{13,15},{14,16},
            {15,17},{15,19},{16,18},{16,20},{11,23},{12,24},{23,24}
        };
        readonly string folder;
        readonly Dictionary<string, MemeAsset> assets;
        string caption, stillCaption;
        Bitmap art, still;
        double stillSince;
        bool animate;
        int epoch;

        public PosePoint[] Points { get; set; }
        public bool HasMeme { get { return caption != null; } }
        public bool HasStill { get { return still != null; } }
        public string Caption { get { return caption; } }

        public PoseDisplay(string folder) {
            this.folder = folder;
            try {
                assets = new JavaScriptSerializer().Deserialize<Dictionary<string, MemeAsset>>(
                    File.ReadAllText(Path.Combine(folder, "memes.json")));
            } catch (Exception error) {
                Trace.WriteLine(error);
                assets = new Dictionary<string, MemeAsset>();
            }
        }

        public int Ticket(bool originalPlaying) { return originalPlaying ? -1 : epoch; }

        public void BeginOriginal() {
            epoch++;
            ClearEffect();
        }

        public bool Show(int ticket, string action, Bitmap frame, bool freeze, double time, bool animate) {
            MemeAsset asset;
            if (ticket != epoch || action == null || !assets.TryGetValue(action, out asset)) return false;
            ClearEffect();
            caption = asset.caption;
            stillCaption = asset.freezeCaption;
            try {
                var path = Path.Combine(folder, asset.image);
                if (File.Exists(path)) {
                    using (var source = Image.FromFile(path)) art = new Bitmap(source);
                }
            } catch (Exception error) { Trace.WriteLine(error); }
            if (freeze && frame != null) {
                try {
                    still = new Bitmap(frame);
                    stillSince = time;
                    this.animate = animate;
                } catch (Exception error) { Trace.WriteLine(error); }
            }
            return true;
        }

        public void Advance(double time) {
            if (HasStill && time - stillSince >= 1) ClearStill();
        }

        public void ClearStill() {
            if (still != null) still.Dispose();
            still = null;
        }

        void ClearEffect() {
            ClearStill();
            if (art != null) art.Dispose();
            art = null;
            caption = stillCaption = null;
        }

        public void DrawMeme(Graphics graphics, Rectangle inset, double time) {
            graphics.FillRectangle(Brushes.Black, inset);
            int textHeight = Math.Max(1, inset.Height / 4);
            var strip = new Rectangle(inset.X, inset.Bottom - textHeight, inset.Width, textHeight);
            var picture = new Rectangle(inset.X, inset.Y, inset.Width, inset.Height - textHeight);
            var image = still ?? art;
            if (image != null && picture.Height > 0) {
                double scale = Math.Min(picture.Width / (double)image.Width, picture.Height / (double)image.Height);
                if (HasStill && animate) scale *= 1 + .12 * Math.Max(0, Math.Min(1, time - stillSince));
                int width = Math.Max(1, (int)(image.Width * scale)), height = Math.Max(1, (int)(image.Height * scale));
                var state = graphics.Save();
                graphics.SetClip(picture);
                graphics.DrawImage(image, new Rectangle(picture.X + (picture.Width - width) / 2,
                    picture.Y + (picture.Height - height) / 2, width, height));
                graphics.Restore(state);
            }
            Cut.Caption(graphics, HasStill ? stillCaption : caption, image == null ? inset : strip,
                Math.Max(10, inset.Width * .065f), Color.Gainsboro);
        }

        public static PointF Project(PosePoint point, Rectangle bounds) {
            return new PointF(bounds.X + point.x * bounds.Width, bounds.Y + point.y * bounds.Height);
        }

        bool Visible(int joint) {
            return joint < Points.Length && Points[joint] != null && Points[joint].visibility >= .55 &&
                !float.IsNaN(Points[joint].x) && !float.IsNaN(Points[joint].y) &&
                !float.IsInfinity(Points[joint].x) && !float.IsInfinity(Points[joint].y);
        }

        public void DrawSkeleton(Graphics graphics, Rectangle bounds) {
            if (Points == null || Points.Length == 0) return;
            var state = graphics.Save();
            graphics.SetClip(bounds);
            using (var pen = new Pen(Color.FromArgb(219,255,103), 2))
            using (var brush = new SolidBrush(pen.Color)) {
                for (int i = 0; i < Bones.GetLength(0); i++) {
                    int a = Bones[i,0], b = Bones[i,1];
                    if (Visible(a) && Visible(b)) graphics.DrawLine(pen, Project(Points[a],bounds), Project(Points[b],bounds));
                }
                for (int joint = 0; joint < Points.Length; joint++) {
                    if (!Visible(joint)) continue;
                    var point = Project(Points[joint], bounds);
                    graphics.FillEllipse(brush, point.X - 2, point.Y - 2, 4, 4);
                }
            }
            graphics.Restore(state);
        }

        [DllImport("user32.dll")]
        static extern bool SystemParametersInfo(uint action, uint param, [MarshalAs(UnmanagedType.Bool)] out bool enabled, uint flags);

        public static bool AnimationsEnabled() {
            bool enabled;
            return SystemParametersInfo(0x1042, 0, out enabled, 0) && enabled;
        }

        public void Dispose() {
            Points = null;
            ClearEffect();
        }
    }
}
