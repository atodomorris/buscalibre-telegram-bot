const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const qs = require("qs"); // npm install qs

// ---------------------------
// Función para limpiar caracteres raros
// ---------------------------
function limpiarTexto(texto) {
  if (!texto) return texto;

  return texto
    .replace(/Â¡/g, "¡")
    .replace(/Â¿/g, "¿")
    .replace(/Ã¡/g, "á")
    .replace(/Ã©/g, "é")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ãº/g, "ú")
    .replace(/Ã±/g, "ñ")
    .replace(/Ã/g, "Á")
    .replace(/&iexcl;/g, "¡");
}

// ---------------------------
// Variables de entorno de Telegram
// ---------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ ERROR: Variables de entorno TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no están definidas.");
  process.exit(1);
}

// ---------------------------
// Función para enviar mensaje a Telegram
// ---------------------------
async function enviarTelegram(promo) {
  const mensaje = `📢 *Nueva promo detectada!*\n\n` +
                  `*Texto:* ${promo.texto}\n` +
                  `*Link:* [Ir a Buscalibre](${promo.link})`;

  try {
    const data = qs.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      photo: promo.imagen,
      caption: mensaje,
      parse_mode: "Markdown"
    });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log("✅ Promo enviada a Telegram!");
  } catch (err) {
    console.error("❌ Error enviando a Telegram:", err.message);
  }
}

// ---------------------------
// Función principal: scraping y envío
// ---------------------------
async function buscarPromo() {
  console.log("🔎 Buscando promo en Buscalibre -", new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  // ---------------------------
  // Scraping del banner principal
  // ---------------------------
  const promo = await page.evaluate(() => {
    const banner = document.querySelector("section#portadaHome a");
    if (!banner) return { texto: "SIN TEXTO", link: "SIN LINK", imagen: "SIN IMAGEN" };

    const img = banner.querySelector("img");
    let link = banner.href;
    if (link && !link.startsWith("http")) {
      link = "https://www.buscalibre.cl" + link;
    }

    return {
      texto: img?.alt || banner.title || "SIN TEXTO",
      link: link || "SIN LINK",
      imagen: img?.src || "SIN IMAGEN"
    };
  });

  promo.texto = limpiarTexto(promo.texto);

  // ---------------------------
  // Comprobar si la promo cambió
  // ---------------------------
  const archivoPromo = "ultimaPromo.json";
  let ultimaPromo = null;

  if (fs.existsSync(archivoPromo)) {
    ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
  }

  if (!ultimaPromo || JSON.stringify(ultimaPromo) !== JSON.stringify(promo)) {
    await enviarTelegram(promo);
    fs.writeFileSync(archivoPromo, JSON.stringify(promo, null, 2), "utf-8");
  } else {
    console.log("ℹ️ Promo sin cambios. No se envía nada.");
  }

  console.log("PROMO DETECTADA:");
  console.log(promo);

  await browser.close();
}

// ---------------------------
// Ejecutar la primera vez
// ---------------------------
buscarPromo();

// ---------------------------
// Ejecutar cada 1 hora
// ---------------------------
setInterval(buscarPromo, 3600000);
