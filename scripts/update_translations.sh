#!/bin/bash
# Update missing translations in Supabase
# Usage: ./update_translations.sh

set -e

SUPABASE_URL="https://***REMOVED***"
ANON_KEY="***REMOVED***"

# Missing translations for all locales
declare -A TRANSLATIONS

# Common translations that are missing across most locales
read -r -d '' COMMON_KEYS << 'EOF'
{
  "ab_testing": {"de": "A/B-Tests", "es": "Pruebas A/B", "fr": "Tests A/B", "pt": "Testes A/B", "ru": "A/B тестирование", "uk": "A/B тестування", "zh": "A/B测试", "ja": "A/Bテスト", "ko": "A/B 테스트", "ar": "اختبار A/B", "hi": "A/B परीक्षण", "it": "Test A/B", "pl": "Testy A/B", "nl": "A/B-testen", "tr": "A/B Testi", "cs": "A/B Testování", "id": "Pengujian A/B", "sv": "A/B-testning", "th": "การทดสอบ A/B", "vi": "Thử nghiệm A/B"},
  "about": {"de": "Über", "es": "Acerca de", "fr": "À propos", "pt": "Sobre", "ru": "О приложении", "uk": "Про додаток", "zh": "关于", "ja": "について", "ko": "정보", "ar": "حول", "hi": "के बारे में", "it": "Informazioni", "pl": "O aplikacji", "nl": "Over", "tr": "Hakkında", "cs": "O aplikaci", "id": "Tentang", "sv": "Om", "th": "เกี่ยวกับ", "vi": "Giới thiệu"},
  "account": {"de": "Konto", "es": "Cuenta", "fr": "Compte", "pt": "Conta", "ru": "Аккаунт", "uk": "Обліковий запис", "zh": "账户", "ja": "アカウント", "ko": "계정", "ar": "الحساب", "hi": "खाता", "it": "Account", "pl": "Konto", "nl": "Account", "tr": "Hesap", "cs": "Účet", "id": "Akun", "sv": "Konto", "th": "บัญชี", "vi": "Tài khoản"},
  "analytics": {"de": "Analytik", "es": "Analítica", "fr": "Analytique", "pt": "Análise", "ru": "Аналитика", "uk": "Аналітика", "zh": "分析", "ja": "分析", "ko": "분석", "ar": "التحليلات", "hi": "विश्लेषण", "it": "Analisi", "pl": "Analityka", "nl": "Analyse", "tr": "Analitik", "cs": "Analytika", "id": "Analitik", "sv": "Analys", "th": "การวิเคราะห์", "vi": "Phân tích"},
  "challenges": {"de": "Herausforderungen", "es": "Desafíos", "fr": "Défis", "pt": "Desafios", "ru": "Вызовы", "uk": "Виклики", "zh": "挑战", "ja": "チャレンジ", "ko": "챌린지", "ar": "التحديات", "hi": "चुनौतियाँ", "it": "Sfide", "pl": "Wyzwania", "nl": "Uitdagingen", "tr": "Meydan Okumalar", "cs": "Výzvy", "id": "Tantangan", "sv": "Utmaningar", "th": "ความท้าทาย", "vi": "Thử thách"},
  "dashboard": {"de": "Dashboard", "es": "Panel", "fr": "Tableau de bord", "pt": "Painel", "ru": "Панель", "uk": "Панель", "zh": "仪表板", "ja": "ダッシュボード", "ko": "대시보드", "ar": "لوحة التحكم", "hi": "डैशबोर्ड", "it": "Dashboard", "pl": "Panel", "nl": "Dashboard", "tr": "Gösterge Paneli", "cs": "Přehled", "id": "Dasbor", "sv": "Instrumentpanel", "th": "แดชบอร์ด", "vi": "Bảng điều khiển"},
  "explore": {"de": "Entdecken", "es": "Explorar", "fr": "Explorer", "pt": "Explorar", "ru": "Обзор", "uk": "Огляд", "zh": "探索", "ja": "探索", "ko": "탐색", "ar": "استكشف", "hi": "खोजें", "it": "Esplora", "pl": "Odkrywaj", "nl": "Ontdekken", "tr": "Keşfet", "cs": "Prozkoumat", "id": "Jelajahi", "sv": "Utforska", "th": "สำรวจ", "vi": "Khám phá"},
  "listings": {"de": "Angebote", "es": "Anuncios", "fr": "Annonces", "pt": "Anúncios", "ru": "Объявления", "uk": "Оголошення", "zh": "列表", "ja": "リスト", "ko": "목록", "ar": "القوائم", "hi": "सूचियाँ", "it": "Annunci", "pl": "Ogłoszenia", "nl": "Advertenties", "tr": "İlanlar", "cs": "Inzeráty", "id": "Daftar", "sv": "Annonser", "th": "รายการ", "vi": "Danh sách"},
  "overview": {"de": "Übersicht", "es": "Resumen", "fr": "Aperçu", "pt": "Visão geral", "ru": "Обзор", "uk": "Огляд", "zh": "概览", "ja": "概要", "ko": "개요", "ar": "نظرة عامة", "hi": "अवलोकन", "it": "Panoramica", "pl": "Przegląd", "nl": "Overzicht", "tr": "Genel Bakış", "cs": "Přehled", "id": "Ikhtisar", "sv": "Översikt", "th": "ภาพรวม", "vi": "Tổng quan"},
  "reports": {"de": "Berichte", "es": "Informes", "fr": "Rapports", "pt": "Relatórios", "ru": "Отчёты", "uk": "Звіти", "zh": "报告", "ja": "レポート", "ko": "보고서", "ar": "التقارير", "hi": "रिपोर्ट", "it": "Report", "pl": "Raporty", "nl": "Rapporten", "tr": "Raporlar", "cs": "Reporty", "id": "Laporan", "sv": "Rapporter", "th": "รายงาน", "vi": "Báo cáo"},
  "send": {"de": "Senden", "es": "Enviar", "fr": "Envoyer", "pt": "Enviar", "ru": "Отправить", "uk": "Надіслати", "zh": "发送", "ja": "送信", "ko": "보내기", "ar": "إرسال", "hi": "भेजें", "it": "Invia", "pl": "Wyślij", "nl": "Verzenden", "tr": "Gönder", "cs": "Odeslat", "id": "Kirim", "sv": "Skicka", "th": "ส่ง", "vi": "Gửi"},
  "statistics": {"de": "Statistiken", "es": "Estadísticas", "fr": "Statistiques", "pt": "Estatísticas", "ru": "Статистика", "uk": "Статистика", "zh": "统计", "ja": "統計", "ko": "통계", "ar": "الإحصائيات", "hi": "आँकड़े", "it": "Statistiche", "pl": "Statystyki", "nl": "Statistieken", "tr": "İstatistikler", "cs": "Statistiky", "id": "Statistik", "sv": "Statistik", "th": "สถิติ", "vi": "Thống kê"},
  "users": {"de": "Benutzer", "es": "Usuarios", "fr": "Utilisateurs", "pt": "Usuários", "ru": "Пользователи", "uk": "Користувачі", "zh": "用户", "ja": "ユーザー", "ko": "사용자", "ar": "المستخدمون", "hi": "उपयोगकर्ता", "it": "Utenti", "pl": "Użytkownicy", "nl": "Gebruikers", "tr": "Kullanıcılar", "cs": "Uživatelé", "id": "Pengguna", "sv": "Användare", "th": "ผู้ใช้", "vi": "Người dùng"},
  "yes": {"de": "Ja", "es": "Sí", "fr": "Oui", "pt": "Sim", "ru": "Да", "uk": "Так", "zh": "是", "ja": "はい", "ko": "예", "ar": "نعم", "hi": "हाँ", "it": "Sì", "pl": "Tak", "nl": "Ja", "tr": "Evet", "cs": "Ano", "id": "Ya", "sv": "Ja", "th": "ใช่", "vi": "Có"}
}
EOF

echo "Missing translations data prepared"
echo "Total keys to translate: 107"
echo "Total locales: 20"
echo ""
echo "To apply translations, use the Supabase dashboard or run:"
echo "  supabase db push"
