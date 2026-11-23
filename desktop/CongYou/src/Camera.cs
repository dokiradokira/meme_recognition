using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Windows.Devices.Enumeration;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
using Windows.Media.MediaProperties;

namespace CongYou {
    internal sealed class Camera : IDisposable {
        MediaCapture capture;
        MediaFrameReader reader;
        byte[] pixels;

        public async Task Open(string deviceId) {
            capture = new MediaCapture();
            await capture.InitializeAsync(new MediaCaptureInitializationSettings {
                VideoDeviceId = deviceId, StreamingCaptureMode = StreamingCaptureMode.Video,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu
            });
            var source = capture.FrameSources.Values
                .Where(s => s.Info.SourceKind == MediaFrameSourceKind.Color)
                .OrderBy(s => s.Info.MediaStreamType == MediaStreamType.VideoPreview ? 0 : 1).FirstOrDefault();
            if (source == null) throw new InvalidOperationException("找不到彩色影像來源。");
            var format = source.SupportedFormats.Where(f => f.VideoFormat != null && f.FrameRate.Denominator > 0)
                .OrderBy(f => f.FrameRate.Numerator / (double)f.FrameRate.Denominator < 20 ? 1 : 0)
                .ThenBy(f => Math.Abs((int)f.VideoFormat.Width - 640)).FirstOrDefault();
            if (format != null) await source.SetFormatAsync(format);
            reader = await capture.CreateFrameReaderAsync(source, MediaEncodingSubtypes.Bgra8);
            reader.AcquisitionMode = MediaFrameReaderAcquisitionMode.Realtime;
            if (await reader.StartAsync() != MediaFrameReaderStartStatus.Success)
                throw new InvalidOperationException("無法取得鏡頭畫面。");
        }
        public Bitmap Next() {
            using (var frame = reader.TryAcquireLatestFrame()) {
                if (frame == null || frame.VideoMediaFrame == null) return null;
                using (var image = frame.VideoMediaFrame.SoftwareBitmap) {
                    if (image == null) return null;
                    return CopyMirrored(image);
                }
            }
        }
        internal Bitmap CopyMirrored(SoftwareBitmap image) {
            int w=image.PixelWidth,h=image.PixelHeight;
            if(pixels==null || pixels.Length!=w*h*4) pixels=new byte[w*h*4];
            image.CopyToBuffer(pixels.AsBuffer());
            var bitmap=new Bitmap(w,h,PixelFormat.Format32bppRgb);
            var data=bitmap.LockBits(new Rectangle(0,0,w,h),ImageLockMode.WriteOnly,bitmap.PixelFormat);
            try { Marshal.Copy(pixels,0,data.Scan0,pixels.Length); }
            finally { bitmap.UnlockBits(data); }
            bitmap.RotateFlip(RotateFlipType.RotateNoneFlipX);
            return bitmap;
        }
        public void Dispose() {
            if (reader != null) reader.Dispose();
            if (capture != null) capture.Dispose();
        }
    }
}
