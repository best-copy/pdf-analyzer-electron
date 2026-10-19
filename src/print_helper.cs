// PDF Editor print helper - Windows printer driver + PDFium.
// Compiled once by print_helper.ps1 (Add-Type -OutputAssembly) and cached.
//
//  Info(printer, devmodeB64, overrides)       -> JSON: normalized DEVMODE + paper/printable area + capabilities
//  Props(printer, devmodeB64, overrides, hwnd)-> shows the DRIVER's own properties dialog, then Info JSON
//  Print(printer, devmodeB64, overrides, file, ...) -> renders pages with PDFium to the printer DC (vector GDI/EMF)
//
// DEVMODE is the driver's settings blob (public part + driver private part). We keep it as base64 between calls
// so the settings chosen in the driver dialog (tray, quality, finishing...) are exactly what we print with.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PeOverrides {
  public static int Copies = 0;      // 0 = keep
  public static int Collate = -1;    // -1 keep, 0/1
  public static int Duplex = 0;      // 0 keep, 1 simplex, 2 long edge, 3 short edge
  public static int Orient = 0;      // 0 keep, 1 portrait, 2 landscape
  public static int Color = 0;       // 0 keep, 1 monochrome, 2 color
  public static int PaperSize = 0;   // 0 keep, DMPAPER_* code
}

public static class PePrint {
  // ---------------- winspool / gdi ----------------
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int DocumentProperties(IntPtr hwnd, IntPtr hPrinter, string name, IntPtr outDm, IntPtr inDm, int mode);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int DeviceCapabilities(string device, string port, short cap, IntPtr output, IntPtr devmode);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDC(string driver, string device, string output, IntPtr devmode);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr hdc, int index);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern IntPtr ResetDC(IntPtr hdc, IntPtr devmode);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDoc(IntPtr hdc, [In] DOCINFOW di);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int EndDoc(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int AbortDoc(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int StartPage(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError = true)] static extern int EndPage(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern int SaveDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool RestoreDC(IntPtr hdc, int saved);
  [DllImport("gdi32.dll")] static extern int IntersectClipRect(IntPtr hdc, int l, int t, int r, int b);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string path);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW {
    public int cbSize = Marshal.SizeOf(typeof(DOCINFOW));
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszOutput;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszDatatype;
    public int fwType;
  }

  // ---------------- PDFium ----------------
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern void FPDF_InitLibrary();
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern void FPDF_DestroyLibrary();
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern bool FPDF_SetPrintMode(int mode);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)] static extern IntPtr FPDF_LoadDocument(string path, string password);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern void FPDF_CloseDocument(IntPtr doc);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern int FPDF_GetPageCount(IntPtr doc);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern uint FPDF_GetLastError();
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern IntPtr FPDF_LoadPage(IntPtr doc, int index);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern void FPDF_ClosePage(IntPtr page);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern float FPDF_GetPageWidthF(IntPtr page);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern float FPDF_GetPageHeightF(IntPtr page);
  [DllImport("pdfium.dll", CallingConvention = CallingConvention.StdCall)] static extern void FPDF_RenderPage(IntPtr dc, IntPtr page, int x, int y, int w, int h, int rotate, int flags);

  const int DM_OUT_BUFFER = 2, DM_IN_PROMPT = 4, DM_IN_BUFFER = 8;
  const int DM_ORIENTATION = 0x1, DM_PAPERSIZE = 0x2, DM_COPIES = 0x100, DM_COLOR = 0x800, DM_DUPLEX = 0x1000, DM_COLLATE = 0x8000;
  // DEVMODEW offsets (public part)
  const int O_SIZE = 68, O_EXTRA = 70, O_FIELDS = 72, O_ORIENT = 76, O_PAPER = 78, O_COPIES = 86, O_COLOR = 92, O_DUPLEX = 94, O_COLLATE = 100, O_FORM = 102;
  const short DC_PAPERS = 2, DC_PAPERSIZE = 3, DC_DUPLEX = 7, DC_COPIES = 18, DC_PAPERNAMES = 16, DC_COLLATE = 22, DC_COLORDEVICE = 32;

  static void Fail(string what) { throw new Exception(what + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message); }

  // ---- DEVMODE helpers ----
  static byte[] DefaultDevmode(IntPtr hp, string printer) {
    int size = DocumentProperties(IntPtr.Zero, hp, printer, IntPtr.Zero, IntPtr.Zero, 0);
    if (size <= 0) Fail("DocumentProperties(size)");
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (DocumentProperties(IntPtr.Zero, hp, printer, buf, IntPtr.Zero, DM_OUT_BUFFER) < 0) Fail("DocumentProperties(default)");
      byte[] b = new byte[size]; Marshal.Copy(buf, b, 0, size); return b;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static short S(byte[] d, int o) { return BitConverter.ToInt16(d, o); }
  static void SetS(byte[] d, int o, int v) { byte[] x = BitConverter.GetBytes((short)v); d[o] = x[0]; d[o + 1] = x[1]; }
  static void AddField(byte[] d, int f) { int v = BitConverter.ToInt32(d, O_FIELDS) | f; byte[] x = BitConverter.GetBytes(v); Array.Copy(x, 0, d, O_FIELDS, 4); }

  static void ApplyOverrides(byte[] d) {
    if (PeOverrides.Copies > 0) { SetS(d, O_COPIES, PeOverrides.Copies); AddField(d, DM_COPIES); }
    if (PeOverrides.Collate >= 0) { SetS(d, O_COLLATE, PeOverrides.Collate); AddField(d, DM_COLLATE); }
    if (PeOverrides.Duplex > 0) { SetS(d, O_DUPLEX, PeOverrides.Duplex); AddField(d, DM_DUPLEX); }
    if (PeOverrides.Orient > 0) { SetS(d, O_ORIENT, PeOverrides.Orient); AddField(d, DM_ORIENTATION); }
    if (PeOverrides.Color > 0) { SetS(d, O_COLOR, PeOverrides.Color); AddField(d, DM_COLOR); }
    if (PeOverrides.PaperSize > 0) { SetS(d, O_PAPER, PeOverrides.PaperSize); AddField(d, DM_PAPERSIZE); }
  }

  // Let the driver validate/merge (also refreshes its private part)
  static byte[] Merge(IntPtr hp, string printer, byte[] dm, IntPtr hwnd, bool prompt, out bool canceled) {
    canceled = false;
    int size = DocumentProperties(IntPtr.Zero, hp, printer, IntPtr.Zero, IntPtr.Zero, 0);
    if (size <= 0) Fail("DocumentProperties(size)");
    IntPtr inB = Marshal.AllocHGlobal(Math.Max(size, dm.Length)), outB = Marshal.AllocHGlobal(size);
    try {
      Marshal.Copy(dm, 0, inB, dm.Length);
      int r = DocumentProperties(hwnd, hp, printer, outB, inB, DM_IN_BUFFER | DM_OUT_BUFFER | (prompt ? DM_IN_PROMPT : 0));
      if (r < 0) Fail("DocumentProperties");
      if (prompt && r == 2) { canceled = true; return dm; }   // IDCANCEL
      byte[] b = new byte[size]; Marshal.Copy(outB, b, 0, size); return b;
    } finally { Marshal.FreeHGlobal(inB); Marshal.FreeHGlobal(outB); }
  }

  static byte[] Prepare(IntPtr hp, string printer, string dmB64) {
    byte[] dm = null;
    if (!String.IsNullOrEmpty(dmB64)) {
      try { dm = Convert.FromBase64String(dmB64); } catch { dm = null; }
      // a DEVMODE from another printer/driver is not valid here
      if (dm != null) {
        string dev = CStr(Encoding.Unicode.GetString(dm, 0, 64));
        if (dm.Length < 104 || !printer.StartsWith(dev, StringComparison.OrdinalIgnoreCase)) dm = null;
      }
    }
    if (dm == null) dm = DefaultDevmode(hp, printer);
    ApplyOverrides(dm);
    bool c; return Merge(hp, printer, dm, IntPtr.Zero, false, out c);
  }

  // fixed-size WCHAR field -> text up to the first NUL (drivers leave garbage after it)
  static string CStr(string s) { int z = s.IndexOf((char)0); return z < 0 ? s : s.Substring(0, z); }

  static IntPtr Pin(byte[] dm) { IntPtr p = Marshal.AllocHGlobal(dm.Length); Marshal.Copy(dm, 0, p, dm.Length); return p; }

  static string J(string s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char ch in s) {
      if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
      else if (ch < 0x20) b.Append("\\u").Append(((int)ch).ToString("x4"));
      else b.Append(ch);
    }
    return b.Append('"').ToString();
  }
  static string N(double v) { return v.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture); }

  // ---- info JSON ----
  static string InfoJson(string printer, byte[] dm) {
    IntPtr pdm = Pin(dm);
    IntPtr hdc = IntPtr.Zero;
    try {
      hdc = CreateDC("WINSPOOL", printer, null, pdm);
      if (hdc == IntPtr.Zero) Fail("CreateDC");
      double dx = GetDeviceCaps(hdc, 88), dy = GetDeviceCaps(hdc, 90);
      double pw = GetDeviceCaps(hdc, 110) / dx * 25.4, ph = GetDeviceCaps(hdc, 111) / dy * 25.4;
      double ox = GetDeviceCaps(hdc, 112) / dx * 25.4, oy = GetDeviceCaps(hdc, 113) / dy * 25.4;
      double hw = GetDeviceCaps(hdc, 8) / dx * 25.4, hh = GetDeviceCaps(hdc, 10) / dy * 25.4;
      StringBuilder sb = new StringBuilder("{");
      sb.Append("\"devmode\":").Append(J(Convert.ToBase64String(dm)));
      sb.Append(",\"paper\":{\"w\":").Append(N(pw)).Append(",\"h\":").Append(N(ph))
        .Append(",\"code\":").Append(S(dm, O_PAPER)).Append(",\"form\":").Append(J(CStr(Encoding.Unicode.GetString(dm, O_FORM, 64)))).Append('}');
      sb.Append(",\"printable\":{\"x\":").Append(N(ox)).Append(",\"y\":").Append(N(oy)).Append(",\"w\":").Append(N(hw)).Append(",\"h\":").Append(N(hh)).Append('}');
      sb.Append(",\"dpi\":").Append(N(dx));
      sb.Append(",\"orient\":").Append(S(dm, O_ORIENT));
      sb.Append(",\"copies\":").Append(S(dm, O_COPIES));
      sb.Append(",\"collate\":").Append(S(dm, O_COLLATE));
      sb.Append(",\"duplex\":").Append(S(dm, O_DUPLEX));
      sb.Append(",\"color\":").Append(S(dm, O_COLOR));
      sb.Append(",\"caps\":{\"duplex\":").Append(DeviceCapabilities(printer, null, DC_DUPLEX, IntPtr.Zero, pdm) == 1 ? "true" : "false")
        .Append(",\"color\":").Append(DeviceCapabilities(printer, null, DC_COLORDEVICE, IntPtr.Zero, pdm) == 1 ? "true" : "false")
        .Append(",\"collate\":").Append(DeviceCapabilities(printer, null, DC_COLLATE, IntPtr.Zero, pdm) == 1 ? "true" : "false")
        .Append(",\"maxCopies\":").Append(DeviceCapabilities(printer, null, DC_COPIES, IntPtr.Zero, pdm)).Append('}');
      sb.Append(",\"papers\":[");
      List<int[]> papers = Papers(printer, pdm);
      List<string> names = PaperNames(printer, pdm);
      for (int i = 0; i < papers.Count; i++) {
        if (i > 0) sb.Append(',');
        sb.Append("{\"code\":").Append(papers[i][0]).Append(",\"w\":").Append(N(papers[i][1] / 10.0)).Append(",\"h\":").Append(N(papers[i][2] / 10.0))
          .Append(",\"name\":").Append(J(i < names.Count ? names[i] : "")).Append('}');
      }
      sb.Append("]}");
      return sb.ToString();
    } finally { if (hdc != IntPtr.Zero) DeleteDC(hdc); Marshal.FreeHGlobal(pdm); }
  }

  // [code, width 0.1mm, height 0.1mm]
  static List<int[]> Papers(string printer, IntPtr pdm) {
    List<int[]> list = new List<int[]>();
    int n = DeviceCapabilities(printer, null, DC_PAPERS, IntPtr.Zero, pdm);
    int n2 = DeviceCapabilities(printer, null, DC_PAPERSIZE, IntPtr.Zero, pdm);
    if (n <= 0 || n2 != n) return list;
    IntPtr a = Marshal.AllocHGlobal(n * 2), b = Marshal.AllocHGlobal(n * 8);
    try {
      DeviceCapabilities(printer, null, DC_PAPERS, a, pdm);
      DeviceCapabilities(printer, null, DC_PAPERSIZE, b, pdm);
      for (int i = 0; i < n; i++) list.Add(new int[] { Marshal.ReadInt16(a, i * 2), Marshal.ReadInt32(b, i * 8), Marshal.ReadInt32(b, i * 8 + 4) });
    } finally { Marshal.FreeHGlobal(a); Marshal.FreeHGlobal(b); }
    return list;
  }
  static List<string> PaperNames(string printer, IntPtr pdm) {
    List<string> list = new List<string>();
    int n = DeviceCapabilities(printer, null, DC_PAPERNAMES, IntPtr.Zero, pdm);
    if (n <= 0) return list;
    IntPtr a = Marshal.AllocHGlobal(n * 64 * 2);
    try {
      DeviceCapabilities(printer, null, DC_PAPERNAMES, a, pdm);
      for (int i = 0; i < n; i++) list.Add(CStr(Marshal.PtrToStringUni(new IntPtr(a.ToInt64() + i * 128), 64)));
    } finally { Marshal.FreeHGlobal(a); }
    return list;
  }

  public static string Info(string printer, string dmB64) {
    IntPtr hp;
    if (!OpenPrinter(printer, out hp, IntPtr.Zero)) Fail("OpenPrinter");
    try { return InfoJson(printer, Prepare(hp, printer, dmB64)); } finally { ClosePrinter(hp); }
  }

  public static string Props(string printer, string dmB64, long hwnd) {
    IntPtr hp;
    if (!OpenPrinter(printer, out hp, IntPtr.Zero)) Fail("OpenPrinter");
    try {
      byte[] dm = Prepare(hp, printer, dmB64);
      bool canceled;
      // powershell.exe is not DPI aware -> Windows bitmap-stretches the driver dialog (blurry at 150-200%).
      // GDI-scaled unaware (-5) for this thread while the dialog is up: text/lines drawn at full resolution, layout and
      // icons keep their size (per-monitor v2 made driver dialogs sharp but shrank their icons/tabs). Windows 10 1809+.
      IntPtr oldCtx = IntPtr.Zero;
      try { oldCtx = SetThreadDpiAwarenessContext(new IntPtr(-5)); } catch (EntryPointNotFoundException) { }
      byte[] outDm;
      try { outDm = Merge(hp, printer, dm, new IntPtr(hwnd), true, out canceled); }
      finally { if (oldCtx != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(oldCtx); } catch (EntryPointNotFoundException) { } } }
      string info = InfoJson(printer, outDm);
      return "{\"canceled\":" + (canceled ? "true" : "false") + "," + info.Substring(1);
    } finally { ClosePrinter(hp); }
  }

  // ---- print ----
  // pages: 0-based indices. scale: fit | actual | shrink | custom. orient: auto | fixed.
  // paperByPage: pick the printer paper matching each page size (ResetDC between pages).
  public static int Print(string printer, string dmB64, string pdfiumPath, string file, string docName, int[] pages,
                          string scale, double pct, bool autoRotate, bool gray, bool annots, bool paperByPage, string outputFile) {
    if (LoadLibrary(pdfiumPath) == IntPtr.Zero) Fail("LoadLibrary(pdfium)");
    IntPtr hp;
    if (!OpenPrinter(printer, out hp, IntPtr.Zero)) Fail("OpenPrinter");
    byte[] dm;
    List<int[]> papers;
    try { dm = Prepare(hp, printer, dmB64); } finally { ClosePrinter(hp); }
    IntPtr pdm = Pin(dm);
    try { papers = Papers(printer, pdm); } finally { Marshal.FreeHGlobal(pdm); }

    FPDF_InitLibrary();
    FPDF_SetPrintMode(0);   // EMF (vector GDI) - works with every GDI driver
    IntPtr doc = FPDF_LoadDocument(file, null);
    if (doc == IntPtr.Zero) throw new Exception("PDF load failed (pdfium error " + FPDF_GetLastError() + ")");
    IntPtr hdc = IntPtr.Zero;
    IntPtr curDm = Pin(dm);
    bool started = false, ok = false;
    int printed = 0;
    try {
      hdc = CreateDC("WINSPOOL", printer, null, curDm);
      if (hdc == IntPtr.Zero) Fail("CreateDC");
      DOCINFOW di = new DOCINFOW(); di.lpszDocName = docName;
      if (!String.IsNullOrEmpty(outputFile)) di.lpszOutput = outputFile;   // tests only: job goes to a file, not the printer
      if (StartDoc(hdc, di) <= 0) Fail("StartDoc");
      started = true;
      int total = FPDF_GetPageCount(doc);
      int flags = 0x800 | (annots ? 0x01 : 0) | (gray ? 0x08 : 0);
      foreach (int pi in pages) {
        if (pi < 0 || pi >= total) continue;
        IntPtr page = FPDF_LoadPage(doc, pi);
        if (page == IntPtr.Zero) throw new Exception("page " + (pi + 1) + " load failed");
        try {
          double pw = FPDF_GetPageWidthF(page), ph = FPDF_GetPageHeightF(page);   // points, /Rotate applied
          if (paperByPage) {
            int[] best = MatchPaper(papers, pw / 72 * 254, ph / 72 * 254);
            byte[] pdmB = (byte[])dm.Clone();
            if (best != null) {
              SetS(pdmB, O_PAPER, best[0]); AddField(pdmB, DM_PAPERSIZE);
              bool pageLand = pw > ph, paperLand = best[1] > best[2];
              SetS(pdmB, O_ORIENT, pageLand != paperLand ? 2 : 1); AddField(pdmB, DM_ORIENTATION);
            }
            Marshal.FreeHGlobal(curDm); curDm = Pin(pdmB);
            if (ResetDC(hdc, curDm) == IntPtr.Zero) Fail("ResetDC");
          }
          if (StartPage(hdc) <= 0) Fail("StartPage");
          double dpx = GetDeviceCaps(hdc, 88), dpy = GetDeviceCaps(hdc, 90);
          double physW = GetDeviceCaps(hdc, 110), physH = GetDeviceCaps(hdc, 111);
          double offX = GetDeviceCaps(hdc, 112), offY = GetDeviceCaps(hdc, 113);
          double horz = GetDeviceCaps(hdc, 8), vert = GetDeviceCaps(hdc, 10);
          int rotate = 0;
          double cw = pw, ch = ph;
          if (autoRotate && ((pw > ph) != (physW > physH)) && Math.Abs(pw - ph) > 1) { rotate = 3; cw = ph; ch = pw; }   // 90 deg counter-clockwise = Windows landscape
          double natW = cw / 72 * dpx, natH = ch / 72 * dpy;      // 100% size in device pixels
          double fit = Math.Min(horz / natW, vert / natH);
          double s = scale == "fit" ? fit : scale == "shrink" ? Math.Min(1, fit) : scale == "custom" ? pct / 100.0 : 1;
          int w = (int)Math.Round(natW * s), h = (int)Math.Round(natH * s);
          int x, y;
          if (scale == "fit") { x = (int)Math.Round((horz - w) / 2); y = (int)Math.Round((vert - h) / 2); }
          else { x = (int)Math.Round((physW - w) / 2 - offX); y = (int)Math.Round((physH - h) / 2 - offY); }   // centered on the sheet
          int saved = SaveDC(hdc);
          IntersectClipRect(hdc, 0, 0, (int)horz, (int)vert);
          FPDF_RenderPage(hdc, page, x, y, w, h, rotate, flags);
          RestoreDC(hdc, saved);
          if (EndPage(hdc) <= 0) Fail("EndPage");
          printed++;
          Console.Out.WriteLine("P:" + printed + "/" + pages.Length);
          Console.Out.Flush();
        } finally { FPDF_ClosePage(page); }
      }
      ok = true;
    } finally {
      if (started) { if (ok) EndDoc(hdc); else AbortDoc(hdc); }
      if (hdc != IntPtr.Zero) DeleteDC(hdc);
      Marshal.FreeHGlobal(curDm);
      FPDF_CloseDocument(doc);
      FPDF_DestroyLibrary();
    }
    return printed;
  }

  // paper [code,w,h] (0.1mm) matching w x h (0.1mm) in either orientation within 3mm
  static int[] MatchPaper(List<int[]> papers, double w, double h) {
    int[] best = null; double bestD = 30;
    foreach (int[] p in papers) {
      if (p[0] >= 256) continue;   // driver custom entries
      double d1 = Math.Max(Math.Abs(p[1] - w), Math.Abs(p[2] - h)), d2 = Math.Max(Math.Abs(p[1] - h), Math.Abs(p[2] - w));
      double d = Math.Min(d1, d2);
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }
}
