// Shows SignalRGB's LCD frames on Lian Li TL Wireless LCD fans (USB 1CBE:0006).
//
// SignalRGB opens a raw USB handle on only one of several identical devices, and gives it to
// whichever plugin instance wins a startup race, so that instance may not match the physical screen.
// Every instance sends its JPEGs here over 127.0.0.1, labelled with its real serial number, and this
// writes them to the screens through WinUSB. The one screen SignalRGB holds can't be opened here, so
// its frames go back to the instance that has the handle.
//
// It builds only frame, brightness, frame rate and version commands, so the startup image (flash)
// and reboot commands can't be sent. Screens are released after a few idle seconds, so L-Connect can
// take them when SignalRGB isn't running.
//
// Protocol from sgtaziz/lian-li-linux (MIT). Not affiliated with Lian Li.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Bridge {
    const int Port = 51872;
    const int RelayPort = 51873;
    const int RelayChunk = 48000;
    const int HelloMs = 1000;
    static readonly UdpClient relay = new UdpClient();
    static readonly IPEndPoint relayTarget = new IPEndPoint(IPAddress.Loopback, RelayPort);
    static int relayFrame;
    static StreamWriter log;
    static readonly object logLock = new object();

    public static void Log(string text) {
        lock (logLock) {
            log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text);
            log.Flush();
        }
    }

    static void RelaySend(string text) {
        byte[] data = Encoding.ASCII.GetBytes(text);
        lock (relay) {
            relay.Send(data, data.Length, relayTarget);
        }
    }

    public static void RelayBrightness(string serial, int percent) {
        RelaySend("LLB1|" + serial + "|B|" + percent);
    }

    public static void RelayFrame(string serial, byte[] jpeg) {
        string encoded = Convert.ToBase64String(jpeg);
        int frame = Interlocked.Increment(ref relayFrame) % 100000;
        int count = (encoded.Length + RelayChunk - 1) / RelayChunk;
        for (int i = 0; i < count; i++) {
            RelaySend("LLB1|" + serial + "|" + frame + "|" + i + "|" + count + "|" + encoded.Substring(i * RelayChunk, Math.Min(RelayChunk, encoded.Length - i * RelayChunk)));
        }
    }

    // Tells the instance with the USB handle that this program is running.
    static void Hello() {
        while (true) {
            RelaySend("LLB1|hello");
            Thread.Sleep(HelloMs);
        }
    }

    static void OpenLog() {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LianLiLcdBridge");
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, "bridge.log");
        if (File.Exists(path) && new FileInfo(path).Length > 200 * 1024) {
            File.Delete(path);
        }
        log = new StreamWriter(path, true);
    }

    static void Main() {
        bool first;
        using (new Mutex(true, "LianLiLcdBridge", out first)) {
            if (!first) {
                return;
            }
            OpenLog();
            Run();
        }
    }

    static void Run() {
        UdpClient udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, Port));
        udp.Client.ReceiveBufferSize = 16 * 1024 * 1024;
        Dictionary<string, Screen> screens = new Dictionary<string, Screen>();
        Dictionary<string, Partial> partials = new Dictionary<string, Partial>();
        Regex serialOk = new Regex("^[0-9A-Za-z]{8,32}$");
        Log("started on 127.0.0.1:" + Port);
        Thread hello = new Thread(Hello);
        hello.IsBackground = true;
        hello.Start();
        while (true) {
            IPEndPoint from = new IPEndPoint(IPAddress.Any, 0);
            byte[] data = udp.Receive(ref from);
            try {
                // LLB1|serial|frame|index|count|base64  or  LLB1|serial|B|percent
                string[] p = Encoding.ASCII.GetString(data).Split('|');
                if (p.Length < 4 || p[0] != "LLB1" || !serialOk.IsMatch(p[1])) {
                    continue;
                }
                Screen screen;
                if (!screens.TryGetValue(p[1], out screen)) {
                    screen = new Screen(p[1]);
                    screens[p[1]] = screen;
                }
                if (p[2] == "B") {
                    screen.SetBrightness(int.Parse(p[3]));
                    continue;
                }
                if (p.Length != 6) {
                    continue;
                }
                int index = int.Parse(p[3]), count = int.Parse(p[4]);
                Partial part;
                if (!partials.TryGetValue(p[1], out part) || part.Frame != p[2]) {
                    part = new Partial(p[2], count);
                    partials[p[1]] = part;
                }
                if (index < 0 || index >= part.Chunks.Length || count != part.Chunks.Length) {
                    continue;
                }
                if (part.Chunks[index] == null) {
                    part.Left--;
                }
                part.Chunks[index] = p[5];
                if (part.Left == 0) {
                    partials.Remove(p[1]);
                    screen.Post(Convert.FromBase64String(string.Concat(part.Chunks)));
                }
            } catch (FormatException) {
                // Not ours, or a damaged frame. The next one replaces it.
            }
        }
    }

    class Partial {
        public readonly string Frame;
        public readonly string[] Chunks;
        public int Left;
        public Partial(string frame, int count) {
            Frame = frame;
            Chunks = new string[Math.Max(1, Math.Min(count, 64))];
            Left = Chunks.Length;
        }
    }
}

class Screen {
    const string InterfaceGuid = "88BAE032-5A81-49f0-BC3D-A4FF138216D6";
    const byte CmdGetVer = 0x0A, CmdBrightness = 0x0E, CmdFrameRate = 0x0F, CmdPushJpg = 0x65;
    const int FrameBytes = 102400, HeaderBytes = 512, MaxJpeg = FrameBytes - HeaderBytes;
    const int IdleCloseMs = 8000, FailsBeforePause = 3, PauseMs = 10000, FirmwareFrameRate = 120;
    const int AccessDenied = 5, HeldRecheckMs = 10000;
    const uint WriteTimeoutMs = 2000, ReadTimeoutMs = 100;
    static readonly byte[] DesKey = Encoding.ASCII.GetBytes("slv3tuzx");

    readonly string serial;
    readonly object gate = new object();
    readonly AutoResetEvent wake = new AutoResetEvent(false);
    readonly byte[] packet = new byte[FrameBytes];
    readonly byte[] reply = new byte[512];
    readonly Stopwatch clock = Stopwatch.StartNew();
    byte[] pending;
    int brightness = -1;
    bool brightnessDirty;
    uint stamp;
    SafeFileHandle file;
    IntPtr usb = IntPtr.Zero;

    public Screen(string serial) {
        this.serial = serial;
        Thread t = new Thread(Work);
        t.IsBackground = true;
        t.Start();
    }

    // Keeps only the newest frame, so a slow screen can't build up a queue.
    public void Post(byte[] jpeg) {
        lock (gate) {
            pending = jpeg;
        }
        wake.Set();
    }

    public void SetBrightness(int percent) {
        lock (gate) {
            brightness = Math.Max(0, Math.Min(100, percent));
            brightnessDirty = true;
        }
        wake.Set();
    }

    void Work() {
        int fails = 0;
        int lastWork = Environment.TickCount;
        long sent = 0;
        while (true) {
            wake.WaitOne(1000);
            byte[] jpeg;
            bool setBrightness;
            int level;
            lock (gate) {
                jpeg = pending;
                pending = null;
                setBrightness = brightnessDirty;
                brightnessDirty = false;
                level = brightness;
            }
            if (jpeg == null && !setBrightness) {
                if (usb != IntPtr.Zero && Environment.TickCount - lastWork > IdleCloseMs) {
                    Bridge.Log(serial + ": idle, releasing the screen");
                    Close();
                }
                continue;
            }
            lastWork = Environment.TickCount;
            if (held && Environment.TickCount - heldSince < HeldRecheckMs) {
                Forward(jpeg, setBrightness, level);
                continue;
            }
            try {
                if (usb == IntPtr.Zero) {
                    try {
                        Open();
                        if (held) {
                            held = false;
                            Bridge.Log(serial + ": no longer held by SignalRGB");
                        }
                    } catch (HeldException) {
                        if (!held) {
                            Bridge.Log(serial + ": held by SignalRGB, sending its frames to the plugin with the handle");
                        }
                        held = true;
                        heldSince = Environment.TickCount;
                        Forward(jpeg, setBrightness, level);
                        continue;
                    }
                }
                if (setBrightness || level >= 0 && !appliedBrightness) {
                    Command(CmdBrightness, new byte[] { MapBrightness(level < 0 ? 100 : level) });
                    appliedBrightness = true;
                }
                if (jpeg != null) {
                    SendFrame(jpeg);
                    sent++;
                    if (sent == 1 || sent % 5000 == 0) {
                        Bridge.Log(serial + ": frames sent " + sent + ", last " + jpeg.Length + " bytes");
                    }
                }
                fails = 0;
            } catch (Exception e) {
                fails++;
                Bridge.Log(serial + ": " + e.Message);
                Close();
                if (fails >= FailsBeforePause) {
                    fails = 0;
                    Thread.Sleep(PauseMs);
                    lock (gate) {
                        pending = null;
                    }
                }
            }
        }
    }

    bool appliedBrightness;
    bool held;
    int heldSince;

    class HeldException : Exception { }

    void Forward(byte[] jpeg, bool setBrightness, int level) {
        if (setBrightness) {
            Bridge.RelayBrightness(serial, level);
        }
        if (jpeg != null) {
            Bridge.RelayFrame(serial, jpeg);
        }
    }

    void Open() {
        string path = @"\\?\usb#vid_1cbe&pid_0006#" + serial + "#{" + InterfaceGuid + "}";
        file = Native.CreateFile(path, 0xC0000000, 3, IntPtr.Zero, 3, 0x40000080, IntPtr.Zero);
        if (file.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            file = null;
            if (error == AccessDenied) {
                throw new HeldException();
            }
            throw new IOException("could not open the screen: error " + error);
        }
        if (!Native.WinUsb_Initialize(file, out usb)) {
            int error = Marshal.GetLastWin32Error();
            file.Dispose();
            usb = IntPtr.Zero;
            throw new IOException("could not start WinUSB: error " + error);
        }
        // A short write timeout cancels a transfer mid-packet, which can wedge the screen.
        Native.WinUsb_SetPipePolicy(usb, 0x01, 3, 4, ref WriteTimeout);
        Native.WinUsb_SetPipePolicy(usb, 0x81, 3, 4, ref ReadTimeout);
        appliedBrightness = false;
        Command(CmdFrameRate, new byte[] { FirmwareFrameRate });
        Command(CmdGetVer, new byte[0]);
        Bridge.Log(serial + ": opened");
    }

    static uint WriteTimeout = WriteTimeoutMs, ReadTimeout = ReadTimeoutMs;

    void Close() {
        if (usb != IntPtr.Zero) {
            Native.WinUsb_Free(usb);
            usb = IntPtr.Zero;
        }
        if (file != null) {
            file.Dispose();
            file = null;
        }
    }

    byte[] Header(byte command, byte[] parameters) {
        byte[] plain = new byte[504];
        plain[0] = command;
        plain[2] = 0x1A;
        plain[3] = 0x6D;
        stamp = Math.Max((uint)clock.ElapsedMilliseconds, stamp + 1);
        BitConverter.GetBytes(stamp).CopyTo(plain, 4);
        parameters.CopyTo(plain, 8);
        using (DESCryptoServiceProvider des = new DESCryptoServiceProvider()) {
            des.Mode = CipherMode.CBC;
            des.Padding = PaddingMode.PKCS7;
            using (ICryptoTransform enc = des.CreateEncryptor(DesKey, DesKey)) {
                return enc.TransformFinalBlock(plain, 0, plain.Length);
            }
        }
    }

    void Write(byte[] data, int length) {
        uint done;
        if (!Native.WinUsb_WritePipe(usb, 0x01, data, (uint)length, out done, IntPtr.Zero) || done != length) {
            throw new IOException("write failed: error " + Marshal.GetLastWin32Error());
        }
    }

    void ReadReply() {
        uint done;
        Native.WinUsb_ReadPipe(usb, 0x81, reply, (uint)reply.Length, out done, IntPtr.Zero);
    }

    void Command(byte command, byte[] parameters) {
        byte[] header = Header(command, parameters);
        Write(header, header.Length);
        ReadReply();
    }

    void SendFrame(byte[] jpeg) {
        if (jpeg.Length < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 || jpeg.Length > MaxJpeg) {
            return;
        }
        byte[] size = BitConverter.GetBytes(jpeg.Length);
        Array.Reverse(size);
        Header(CmdPushJpg, size).CopyTo(packet, 0);
        jpeg.CopyTo(packet, HeaderBytes);
        Array.Clear(packet, HeaderBytes + jpeg.Length, FrameBytes - HeaderBytes - jpeg.Length);
        Write(packet, FrameBytes);
        ReadReply();
    }

    // Maps 0-100 to what this firmware expects. Values from lian-li-linux.
    static byte MapBrightness(int percent) {
        int[,] anchors = { { 0, 0 }, { 25, 10 }, { 50, 30 }, { 75, 40 }, { 100, 100 } };
        for (int i = 1; i < 5; i++) {
            if (percent <= anchors[i, 0]) {
                return (byte)(anchors[i - 1, 1] + (percent - anchors[i - 1, 0]) * (anchors[i, 1] - anchors[i - 1, 1]) / (anchors[i, 0] - anchors[i - 1, 0]));
            }
        }
        return 100;
    }
}

class Stopwatch {
    readonly System.Diagnostics.Stopwatch w = new System.Diagnostics.Stopwatch();
    public static Stopwatch StartNew() {
        Stopwatch s = new Stopwatch();
        s.w.Start();
        return s;
    }
    public long ElapsedMilliseconds { get { return w.ElapsedMilliseconds; } }
}

static class Native {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("winusb.dll", SetLastError = true)]
    public static extern bool WinUsb_Initialize(SafeFileHandle device, out IntPtr usb);
    [DllImport("winusb.dll", SetLastError = true)]
    public static extern bool WinUsb_Free(IntPtr usb);
    [DllImport("winusb.dll", SetLastError = true)]
    public static extern bool WinUsb_SetPipePolicy(IntPtr usb, byte pipe, uint policy, uint length, ref uint value);
    [DllImport("winusb.dll", SetLastError = true)]
    public static extern bool WinUsb_WritePipe(IntPtr usb, byte pipe, byte[] data, uint length, out uint done, IntPtr overlapped);
    [DllImport("winusb.dll", SetLastError = true)]
    public static extern bool WinUsb_ReadPipe(IntPtr usb, byte pipe, byte[] data, uint length, out uint done, IntPtr overlapped);
}
