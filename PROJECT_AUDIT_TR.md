# CS 1.6 Web Panel — UI, Özellik, Güvenlik ve Performans Denetimi

Tarih: 16 Temmuz 2026

## 1. Kapsam ve mevcut ürün

Panel; Node.js/Express, MySQL, Docker, vanilla HTML/CSS/JavaScript ve WebSocket tabanlı bir CS 1.6 sunucu yönetim ürünü. İncelenen ana akışlar:

- Kayıt, giriş, kullanıcı ve bakiye yönetimi
- Sunucu kiralama, başlatma, durdurma, yeniden başlatma, sıfırlama ve silme
- Canlı konsol/RCON, log ve çökme logları
- Dosya, klasör, harita, mapcycle ve AMX Mod X eklenti yönetimi
- Oyuncu geçmişi, liderlik tablosu, oyuncu işlemleri, admin ve ban yönetimi
- FastDL, sunucuya özel MySQL ve PHP alanları
- Ödeme bildirimi ve dekont yönetimi
- Yönetici paneli, fiyat/paket ayarları ve kullanıcı işlemleri

Ürün işlevsel olarak geniş; en önemli eksikler güvenlik sertleştirmesi, operasyonel güvenilirlik, kodun modülerleştirilmesi ve ölçekli gözlemlenebilirlik alanlarında.

## 2. Bu çalışmada tamamlanan iyileştirmeler

### UI ve kullanılabilirlik

- Panel, CS 1.6/GoldSrc karakterine uygun “operations console” görsel sistemiyle yeniden tasarlandı.
- Mobilde içeriğin önüne yığılan uzun sol menü, erişilebilir açılır çekmeceye dönüştürüldü.
- Sunucu arama ve durum filtresi eklendi.
- Yeni Fleet Overview ekranına yönetilen sunucu, çevrimiçi sunucu, oyuncu ve dikkat gerektiren sunucu özetleri eklendi.
- Hızlı sunucu kartları ve altyapı kısayolları eklendi.
- Sunucu adresini kopyalama işlemi eklendi.
- Aktif menü, aktif sunucu ve sekme durumları semantik/erişilebilir hale getirildi.
- Form etiketleri, odak stilleri, azaltılmış hareket tercihi, modal başlıkları ve kapatma butonları iyileştirildi.
- Landing sayfası aynı görsel dile taşındı; tablo ve özellik alanları responsive hale getirildi.
- Yönetici için sunucu oluşturma butonlarının görünmesini engelleyen hata giderildi.

### Özellik ve güvenilirlik

- Kiralama sırasında container'a MySQL parolasının RCON parolası olarak yazılması düzeltildi. İstenen RCON parolası artık doğrulanıp hem veritabanına hem container ortamına aynı değerle yazılıyor.
- RCON parola üretimi `Math.random()` yerine kriptografik rastgelelik ve 16 karakter kullanıyor.
- 27015 ve 27016 korumalı portları kiralama/sıfırlama gibi yıkıcı işlemlerden korunuyor.
- Ödeme dekontları artık genel `/uploads` dizininden yayımlanmıyor; yalnızca dekont sahibi veya yönetici kimlik doğrulamalı uçtan erişebiliyor.
- Dekont yüklemede uzantı/MIME bilgisinin yanında PNG, JPEG ve PDF dosya imzaları doğrulanıyor.
- Dekont tutarı ve gönderen alanı sınırlandı; başarısız işlemlerde yetim yüklenen dosyalar temizleniyor.
- Geniş sunucu listesi yanıtından RCON parolası kaldırıldı.
- Tarayıcı oturum belirteci kalıcı `localStorage` alanından kaldırıldı; üretimde HttpOnly cookie öncelikli akış kullanılıyor.
- Aynı anda yinelenen sunucu listesi istekleri tek Promise üzerinde birleştirildi.
- Sunucu yenileme 45 saniyeye çekildi; görünmeyen sekmede polling duruyor.
- Ödeme dekontu görüntüleme kimlik doğrulamalı fetch + geçici Blob URL ile çalışıyor; URL'ler modal kapanırken temizleniyor.
- Kök domainin landing yerine yanlışlıkla paneli göstermesine neden olan host yönlendirme hatası düzeltildi.

### Performans ve HTTP katmanı

- HTML/CSS/JavaScript ve API yanıtlarına gzip sıkıştırma eklendi.
- Sürüm parametreli statik CSS/JS dosyalarına 7 günlük cache ve stale-while-revalidate eklendi.
- HTML'e no-cache; hassas API yanıtlarına no-store politikası uygulandı.
- Güvenlik başlıkları eklendi: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Herkese açık sunucu listesi 10 saniyelik bellek önbelleğine alındı.
- Public listeden kullanılmayan oyuncu listesi, mapcycle ve yapılandırma dosyası okumaları çıkarıldı.
- Landing polling'i sayfa görünmezken duruyor.
- Yinelenen admin dashboard fonksiyonu ve kullanılmayan eski PHP dosya yükleyicisi kaldırıldı.

## 3. Kalan P0 — yayına çıkmadan önce

### Kimlik doğrulama ve yetkilendirme

1. Giriş/kayıt uçlarına IP + kullanıcı bazlı rate limit, artan gecikme ve hesap kilitleme politikası eklenmeli.
2. Yönetici hesaplarına TOTP/WebAuthn tabanlı 2FA eklenmeli.
3. Kayıt akışı açık üretim kaydı olacaksa e-posta doğrulaması ve bot koruması eklenmeli; değilse davet koduna bağlanmalı.
4. Mevcut `admin/user` seed hesapları ve fallback parolaları üretim başlangıcında zorunlu olarak reddedilmeli.
5. Yönetici/kullanıcı ikilisi yerine kaynak bazlı RBAC izinleri oluşturulmalı.

### Gizli bilgiler ve altyapı

1. Docker socket panel container'ına doğrudan yazılabilir bağlanmış durumda. Bu erişim host üzerinde root eşdeğeridir; Docker socket proxy ve izin verilen API listesi kullanılmalı.
2. Compose fallback sırları ve BHOP servisindeki açık DB parolası kaldırılmalı; Docker Secrets veya harici secret store'a taşınmalı ve mevcut sırlar döndürülmeli.
3. RCON ve sunucu DB parolaları veritabanında düz metin tutulmamalı; uygulama seviyesinde envelope encryption uygulanmalı.
4. WebSocket query token desteği kaldırılmalı. Cookie dışı token zorunluysa kısa ömürlü tek kullanımlık handoff token kullanılmalı ve Origin doğrulaması tüm kaynaklarda zorunlu olmalı.
5. Content-Security-Policy henüz güvenle açılamıyor. Inline handler/style ve dinamik HTML kullanımları kaldırıldıktan sonra nonce/hash tabanlı katı CSP devreye alınmalı.

### Para ve kiralama tutarlılığı

Kiralama akışı bakiye düşümü, sahiplik güncellemesi, container/volume değişikliği ve DB provizyonunu tek atomik süreç olarak ele almıyor. Container oluşturma veya ağ/DB provizyonu ara aşamada hata verirse bakiye ve sahiplik tutarsız kalabilir. Aşağıdaki saga uygulanmalı:

1. DB transaction ile ücret rezervasyonu ve pool kaydının satır kilidi (`SELECT ... FOR UPDATE`)
2. İdempotency key ile çift tıklama/tekrar istek koruması
3. Container/volume/DB provizyon adımları
4. Başarılıysa transaction finalize, başarısızsa otomatik telafi: ücret iadesi, pool sahipliği ve container durumu geri alma
5. Yarım kalan işlemleri toparlayan periyodik reconciliation job

## 4. Kalan P1 — ürün ve operasyon özellikleri

### Sunucu yaşam döngüsü

- Zamanlanmış yeniden başlatma, harita değiştirme, duyuru ve bakım görevleri
- Otomatik ve manuel snapshot/backup; tek tıkla restore; retention ve uzak obje depolama
- Sunucu klonlama, hazır oyun modu şablonları ve konfigürasyon preset'leri
- Config sürüm geçmişi, diff, onay ve geri alma
- Süre dolmadan bildirim, otomatik yenileme ve başarısız yenileme senaryosu
- Sunucu taşıma/drain ve bakım modu

### Gözlemlenebilirlik

- CPU/RAM/ağ/disk, tick/FPS, oyuncu ve çökme verilerini zaman serisi olarak saklama
- Offline, yüksek CPU, düşük FPS, disk doluluğu, tekrarlı çökme ve FastDL senkronizasyon hatası alarmları
- E-posta/Discord/Slack/webhook bildirim kanalları ve sessiz saatler
- Merkezi yapılandırılmış JSON log, correlation/request ID, audit log ve yönetici aktivite geçmişi
- Prometheus/OpenTelemetry metrikleri; panel ve bağımlılıklar için health/readiness uçları

### Dosya, harita ve eklenti yönetimi

- Sunucu taraflı sayfalama/arama; çok büyük dizinlerde sanallaştırılmış liste
- Zip oluşturma/açma, toplu taşıma/kopyalama/silme ve indirme
- Yükleme kota/boş disk kontrolü ve kesintiye dayanıklı chunk upload
- Eklenti/harita kataloğu; sürüm, bağımlılık, uyumluluk ve çakışma denetimi
- Eklenti güncelleme bildirimi, güvenli deneme/rollback ve checksum doğrulaması
- AMXX derleme loglarının saklanması ve indirilebilir artifact geçmişi

### Kullanıcı ve ödeme

- Profil, parola değiştirme, aktif oturumlar ve tüm oturumlardan çıkış
- Bildirim merkezi ve okunmadı durumu
- Fatura/makbuz, kupon, vergi ve ödeme sağlayıcısı webhook entegrasyonu
- Ödeme işlemlerinde idempotency, durum makinesi ve otomatik mutabakat
- Destek talebi ve sunucuya bağlı olay kaydı

## 5. Kalan P1 — mimari ve performans

1. `public/index.html` 1.245 satır, `public/app.js` 3.438 satır. Ekranlar ES module'lere, küçük view/controller katmanlarına ve tekrar kullanılabilir bileşenlere bölünmeli.
2. Kodda kalan 98 `innerHTML` ve 121 native `alert/prompt/confirm` kullanımı güvenlik, erişilebilirlik ve test edilebilirliği düşürüyor. Güvenli DOM üreticileri, toast, confirm modal ve form modal bileşenlerine taşınmalı.
3. `/api/servers` hâlâ cache süresi dolduğunda Docker list/inspect ile A2S/RCON sorgularını istek yolunda yapıyor. Arka plan collector + durum deposu + SSE/WebSocket delta yayınına geçilmeli.
4. Dosya, oyuncu, admin, ödeme ve kaynak listelerine sunucu taraflı pagination/filter/sort uygulanmalı.
5. Startup sırasında çalışan ALTER yaklaşımı yerine sürümlü migration aracı ve rollback planı kullanılmalı.
6. SIGTERM/SIGINT graceful shutdown, HTTP connection drain, WebSocket kapatma ve worker durdurma uygulanmalı.
7. Panel servisinde container healthcheck/readiness ve bağımlılık timeout/retry politikası eklenmeli.
8. Docker build `npm install` yerine kilit dosyasını birebir kullanan `npm ci --omit=dev` çalıştırmalı.
9. CI pipeline; lint, unit, integration, güvenlik taraması, image taraması ve smoke test içermeli.
10. Frontend asset'leri üretim build'iyle minify edilmeli; içerik hash'li isimlerle immutable cache kullanılmalı.

## 6. Kalan P2 — UI/UX ayrıntıları

- Arayüzde Türkçe ve İngilizce karışık; tek dil veya gerçek i18n sözlüğü seçilmeli.
- Native prompt/confirm/alert akışları ürün modalı/toast sistemiyle değiştirilip alan bazlı hata gösterilmeli.
- Modallere tam focus trap, açan elemana focus restore ve Escape politikası eklenmeli.
- Mobilde yoğun yönetici/MySQL/dosya tabloları kart görünümü veya öncelikli kolon yaklaşımı kullanmalı.
- Kritik eylemlerde sonuç özeti, devam eden işlem göstergesi ve geri alınabilir toast eklenmeli.
- İlk kullanım turu, bağlamsal yardım ve operasyon runbook bağlantıları eklenmeli.
- Boş durumlar daha açıklayıcı ve aksiyon odaklı hale getirilmeli.
- Klavye kısayolları; sunucu arama, komut paleti ve hızlı geçiş eklenmeli.
- Tema kontrastı WCAG AA otomatik testine bağlanmalı.

## 7. Ölçümler

Yerel Docker stack üzerinde, `Accept-Encoding: gzip` ile yapılan doğrulama:

| Kaynak | Sonuç |
|---|---:|
| `style.css` sıkıştırılmış transfer | yaklaşık 8,1 KB |
| `app.js` sıkıştırılmış transfer | yaklaşık 32,7 KB |
| `landing.css` sıkıştırılmış transfer | yaklaşık 4,2 KB |
| Public sunucu listesi gövdesi | 1.069 B |
| Public sunucu listesi sıcak yanıt | yaklaşık 3–4 ms |
| CSS/JS cache | 7 gün + 1 gün stale-while-revalidate |
| `/uploads` genel erişim | 404 |
| Yetkisiz dekont erişimi | 401 |

Not: Chrome DevTools performans trace aracı bu oturumda erişilebilir olmadığı için LCP, CLS, INP ve TBT değerleri uydurulmadı. Gerçek üretim URL'sinde mobil/masaüstü Lighthouse ve WebPageTest ölçümü ayrıca yapılmalı.

## 8. Doğrulama sonucu

- `npm test`: 11/11 başarılı
- `npm run check`: başarılı
- `npm audit --omit=dev`: bilinen güvenlik açığı bulunmadı
- `npm run test:local-stack`: başarılı
- Dosya/harita overwrite, SMA→AMXX derleme, FastDL wav/tga/bsp ve 126 dosyalı klasör batch senaryoları başarılı
- Landing, giriş, masaüstü dashboard ve mobil çekmece/arama akışları görsel olarak kontrol edildi
- CSS/JS gzip ve cache başlıkları doğrulandı
- Public upload engeli ve sahiplik kontrollü dekont uç noktası doğrulandı

## 9. Önerilen uygulama sırası

1. P0 secret rotation + Docker socket proxy + auth rate limit/2FA
2. Kiralama saga/transaction/idempotency ve reconciliation
3. CSP için inline handler/HTML refactor
4. Audit log, metrik collector, healthcheck ve alarm sistemi
5. Backup/restore ve zamanlanmış görevler
6. Frontend modülerleştirme, pagination ve native dialog dönüşümü
7. Config sürümleme, şablon/katalog ve ödeme otomasyonu
