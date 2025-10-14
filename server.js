  import express from "express";
  import { WebSocketServer } from "ws";
  import bodyParser from "body-parser";
  import fs from "fs";
  import QRCode from "qrcode";
  import generatePayload from "promptpay-qr";
   import multer from "multer";

  const app = express();
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(express.static("public"));

 

// 📁 ตั้งค่า multer ให้เก็บไฟล์ใน public/uploads/ และใช้ชื่อจริงของไฟล์
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// ✅ route สำหรับอัปโหลดรูป popup
app.post("/upload-popup", upload.single("popupImage"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ไม่พบไฟล์" });
  const imagePath = "/uploads/" + req.file.filename;
  console.log("🖼️ อัปโหลดภาพ popup แล้ว:", imagePath);
  res.json({ path: imagePath });
});
  // 🌐 WebSocket สำหรับ OBS
  const wss = new WebSocketServer({ port: 3001 });
  wss.on("connection", () => console.log("🟢 WebSocket ใหม่เชื่อมต่อเข้ามาแล้ว!"));

  // 🧠 ตัวเก็บ QR ที่รอการโอนจริง
  let pendingDonations = []; // [{ name, amount, comment, time }]

  // 💾 บันทึกโดเนททั้งหมด
  const donateFile = "donates.json";
  if (!fs.existsSync(donateFile)) fs.writeFileSync(donateFile, "[]", "utf8");

  // 🔧 ฟังก์ชันบันทึกข้อมูล
  function saveDonate(name, amount, comment = "") {
    const data = JSON.parse(fs.readFileSync(donateFile, "utf8"));
    const record = { name, amount, comment, time: new Date().toLocaleString("th-TH") };
    data.unshift(record);
    fs.writeFileSync(donateFile, JSON.stringify(data, null, 2));
    console.log("💾 บันทึกโดเนท:", record);
  }

  // 🔧 ส่งข้อมูลไป OBS
  function sendToOBS(data) {
    let sent = 0;
    wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify(data));
        sent++;
      }
    });
    console.log(`📡 ส่งข้อมูลไป OBS ${sent} ตัว`, data);
  }

  // ✅ สร้าง QR และบันทึกไว้ใน pending
  app.post("/generateQR", (req, res) => {
    const { amount, name, comment } = req.body;
    if (!amount) return res.status(400).json({ error: "กรุณาระบุจำนวนเงิน" });

    const payload = generatePayload("0815404297", { amount: parseFloat(amount) });
    QRCode.toDataURL(payload, (err, url) => {
      if (err) return res.status(500).json({ error: err.message });

      // ลบ QR เก่าที่ค้างไว้นานกว่า 10 นาที
      const now = Date.now();
      pendingDonations = pendingDonations.filter(p => now - p.time < 600000);

      // เพิ่มรายการใหม่
      pendingDonations.push({
        name: name || "ไม่ระบุชื่อ",
        amount: parseFloat(amount),
        comment: comment || "",
        time: now
      });

      console.log(`🕓 รอการโอนจริงจาก ${name || "ไม่ระบุชื่อ"} (${amount} บาท)`);

      res.json({ result: url });
    });
  });

  // ✅ ดูรายชื่อโดเนทย้อนหลัง
  app.get("/donates", (req, res) => {
    const data = JSON.parse(fs.readFileSync(donateFile, "utf8"));
    res.json(data.reverse());
  });

  // ✅ รับข้อมูลจากมือถือ (Tasker)
  // ✅ รับ webhook จากมือถือ (Tasker)
  app.post("/bankhook", (req, res) => {
    console.log("✅ ได้รับ Webhook จากมือถือ:", req.body);

    const text = req.body.text || "";
    if (!text) {
      console.log("⚠️ ไม่มีข้อความใน body");
      return res.json({ ok: false });
    }

    console.log("📨 แจ้งเตือนจากมือถือ:", text);

    const looksLikeIncoming = /(ยอดเงิน|จำนวนเงิน|รับเงิน|ฝาก|โอนเข้า|เงินเข้า)/i.test(text);
    if (!looksLikeIncoming) {
      console.log("⏩ ไม่ใช่ข้อความเงินเข้า ข้าม...");
      return res.json({ ok: true });
    }

    const match = text.match(/([\d,]+(?:\.\d+)?)\s*บาท/i);
    const amount = match ? parseFloat(match[1].replace(/,/g, "")) : 0;

if (amount > 0) {
  const pending = pendingDonations.find(p => Math.abs(p.amount - amount) < 0.2);
  const donorName = pending ? pending.name : "ผู้บริจาคจากมือถือ 📱";
  const comment = pending ? (pending.comment || "") : "";

  console.log(`💖 ตรวจพบยอดเงิน ${amount} บาท จาก ${donorName}`);

  // ✅ บันทึกโดเนทลงไฟล์
  saveDonate(donorName, amount, comment);

  // ✅ ส่งแค่ครั้งเดียว
  sendToOBS({
    type: "donate",
    name: donorName,
    amount,
    comment: comment || "ขอบคุณสำหรับการสนับสนุน 💖"
  });

  // ✅ ถ้ามีรายการค้าง ก็ล้างออก + แจ้ง payment_done
  if (pending) {
    console.log(`✅ ตรวจพบการชำระจริงของ ${pending.name} (${amount} บาท)`);
    pendingDonations = pendingDonations.filter(p => p !== pending);

    sendToOBS({
      type: "payment_done",
      name: pending.name,
      amount: amount
    });

    console.log("♻️ ล้างรายการรอชำระสำเร็จ");
  }


      if (pending)
        pendingDonations = pendingDonations.filter(p => p !== pending);
    }

    res.json({ ok: true });
  });



  // ✅ Route ทดสอบ popup alert
  app.get("/test", (req, res) => {
    sendToOBS({
      type: "donate",
      name: "เฟอ",
      amount: 99,
      comment: "ขอบคุณที่เทสต์ระบบ 💖"
    });
    console.log("📡 ส่งทดสอบ alert ไป OBS แล้ว!");
    res.send("✅ ส่งทดสอบ Alert แล้ว! ดู OBS ได้เลย");
  });

  // 🧹 ล้าง QR ที่ค้างไว้นานเกิน 10 นาที
  setInterval(() => {
    const before = pendingDonations.length;
    const now = Date.now();
    pendingDonations = pendingDonations.filter(p => now - p.time < 600000);
    if (pendingDonations.length !== before)
      console.log(`🧹 ล้าง QR เก่าทิ้ง ${before - pendingDonations.length} รายการ`);
  }, 60000);


// ✅ Route สำหรับกด Alert ซ้ำจาก Dashboard
app.post("/test-alert", (req, res) => {
  const { name, amount, comment } = req.body;

  // ส่งข้อมูลไป OBS ทันที
  sendToOBS({
    type: "alert_repeat",
    name,
    amount,
    comment: comment || "ขอบคุณสำหรับการสนับสนุน 💖",
    fromDashboard: true
  });

  console.log(`🔔 ส่ง Alert ซ้ำจาก Dashboard: ${name} - ${amount}฿`);
  res.json({ ok: true });
});


// ✅ Route ทดสอบ Alert จากหน้า customize.html
app.post("/customize-test", (req, res) => {
  const { text, color, effect } = req.body;

  // ส่ง event ไป OBS
  sendToOBS({
    type: "alert_test",
    name: "H0LLoWx 💖",
    amount: 99,
    comment: text || "ขอบคุณสำหรับการสนับสนุน 💖",
    color: color || "#69eaff",
    effect: effect || "pop"
  });

  console.log("🎨 ส่ง alert_test ไป OBS สำเร็จ!");
  res.json({ ok: true });
});


// 📂 โหลด config ล่าสุด
app.get("/config", (req, res) => {
  try {
    const config = fs.readFileSync("config.json", "utf8");
    res.json(JSON.parse(config));
  } catch (err) {
    // ถ้าไม่มีไฟล์ config.json → คืนค่าเริ่มต้น
    res.json({
      sound: "alert.mp3",
      popupImage: "images/default.png",
      color: "#69eaff",
      animation: "pop",
      minAmount: 10
    });
  }
});

// 💾 บันทึก config ใหม่จากหน้า customize
app.post("/save-config", (req, res) => {
  fs.writeFileSync("config.json", JSON.stringify(req.body, null, 2));
  console.log("✅ บันทึกการตั้งค่าใหม่แล้ว:", req.body);
  // 🔄 แจ้ง OBS ให้รีเฟรช config ทันที
  sendToOBS({ type: "config_update", config: req.body });
  res.json({ ok: true });
});

// 📂 โหลด config ล่าสุด
app.get("/config", (req, res) => {
  const config = fs.readFileSync("config.json", "utf8");
  res.json(JSON.parse(config));
});

// 💾 บันทึก config ใหม่จากหน้า customize
app.post("/save-config", (req, res) => {
  fs.writeFileSync("config.json", JSON.stringify(req.body, null, 2));
  console.log("✅ บันทึกการตั้งค่าใหม่แล้ว:", req.body);
  sendToOBS({ type: "config_update", config: req.body }); // 🔄 แจ้ง OBS ให้รีเฟรชการตั้งค่า
  res.json({ ok: true });
});


// ✅ เสิร์ฟหน้าเว็บหลัก index.html
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// ✅ เสิร์ฟหน้า alert สำหรับ OBS
app.get("/alert", (req, res) => {
  res.sendFile("alert.html", { root: "public" });
});

  // ✅ เริ่มรันเซิร์ฟเวอร์
 const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
