-- Add missing translations to all locales
-- Generated: 2026-01-08

-- Function to add missing key to a locale's messages JSONB
CREATE OR REPLACE FUNCTION add_translation_key(p_locale TEXT, p_key TEXT, p_value TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE translations 
  SET messages = messages || jsonb_build_object(p_key, p_value),
      version = to_char(NOW(), 'YYYYMMDDHH24MISS'),
      updated_at = NOW()
  WHERE locale = p_locale 
    AND NOT (messages ? p_key);
END;
$$ LANGUAGE plpgsql;

-- Add missing keys for each locale
-- German (de)
SELECT add_translation_key('de', 'ab_testing', 'A/B-Tests');
SELECT add_translation_key('de', 'about', 'Über');
SELECT add_translation_key('de', 'account', 'Konto');
SELECT add_translation_key('de', 'analytics', 'Analytik');
SELECT add_translation_key('de', 'challenges', 'Herausforderungen');
SELECT add_translation_key('de', 'dashboard', 'Dashboard');
SELECT add_translation_key('de', 'explore', 'Entdecken');
SELECT add_translation_key('de', 'listings', 'Angebote');
SELECT add_translation_key('de', 'overview', 'Übersicht');
SELECT add_translation_key('de', 'reports', 'Berichte');
SELECT add_translation_key('de', 'send', 'Senden');
SELECT add_translation_key('de', 'statistics', 'Statistiken');
SELECT add_translation_key('de', 'users', 'Benutzer');
SELECT add_translation_key('de', 'yes', 'Ja');
SELECT add_translation_key('de', 'forum_title', 'Community-Forum');
SELECT add_translation_key('de', 'forum_new_post', 'Neuer Beitrag');
SELECT add_translation_key('de', 'create_listing', 'Angebot erstellen');
SELECT add_translation_key('de', 'contact_sharer', 'Teiler kontaktieren');

-- Spanish (es)
SELECT add_translation_key('es', 'ab_testing', 'Pruebas A/B');
SELECT add_translation_key('es', 'about', 'Acerca de');
SELECT add_translation_key('es', 'account', 'Cuenta');
SELECT add_translation_key('es', 'analytics', 'Analítica');
SELECT add_translation_key('es', 'challenges', 'Desafíos');
SELECT add_translation_key('es', 'dashboard', 'Panel');
SELECT add_translation_key('es', 'explore', 'Explorar');
SELECT add_translation_key('es', 'listings', 'Anuncios');
SELECT add_translation_key('es', 'overview', 'Resumen');
SELECT add_translation_key('es', 'reports', 'Informes');
SELECT add_translation_key('es', 'send', 'Enviar');
SELECT add_translation_key('es', 'statistics', 'Estadísticas');
SELECT add_translation_key('es', 'users', 'Usuarios');
SELECT add_translation_key('es', 'yes', 'Sí');
SELECT add_translation_key('es', 'forum_title', 'Foro comunitario');
SELECT add_translation_key('es', 'forum_new_post', 'Nuevo post');
SELECT add_translation_key('es', 'create_listing', 'Crear anuncio');
SELECT add_translation_key('es', 'contact_sharer', 'Contactar compartidor');

-- Portuguese (pt)
SELECT add_translation_key('pt', 'ab_testing', 'Testes A/B');
SELECT add_translation_key('pt', 'about', 'Sobre');
SELECT add_translation_key('pt', 'account', 'Conta');
SELECT add_translation_key('pt', 'analytics', 'Análise');
SELECT add_translation_key('pt', 'challenges', 'Desafios');
SELECT add_translation_key('pt', 'dashboard', 'Painel');
SELECT add_translation_key('pt', 'explore', 'Explorar');
SELECT add_translation_key('pt', 'listings', 'Anúncios');
SELECT add_translation_key('pt', 'overview', 'Visão geral');
SELECT add_translation_key('pt', 'reports', 'Relatórios');
SELECT add_translation_key('pt', 'send', 'Enviar');
SELECT add_translation_key('pt', 'statistics', 'Estatísticas');
SELECT add_translation_key('pt', 'users', 'Usuários');
SELECT add_translation_key('pt', 'yes', 'Sim');
SELECT add_translation_key('pt', 'forum_title', 'Fórum da comunidade');
SELECT add_translation_key('pt', 'forum_new_post', 'Nova publicação');
SELECT add_translation_key('pt', 'create_listing', 'Criar anúncio');
SELECT add_translation_key('pt', 'contact_sharer', 'Contactar partilhador');

-- Russian (ru)
SELECT add_translation_key('ru', 'ab_testing', 'A/B тестирование');
SELECT add_translation_key('ru', 'about', 'О приложении');
SELECT add_translation_key('ru', 'account', 'Аккаунт');
SELECT add_translation_key('ru', 'analytics', 'Аналитика');
SELECT add_translation_key('ru', 'challenges', 'Вызовы');
SELECT add_translation_key('ru', 'dashboard', 'Панель');
SELECT add_translation_key('ru', 'explore', 'Обзор');
SELECT add_translation_key('ru', 'listings', 'Объявления');
SELECT add_translation_key('ru', 'overview', 'Обзор');
SELECT add_translation_key('ru', 'reports', 'Отчёты');
SELECT add_translation_key('ru', 'send', 'Отправить');
SELECT add_translation_key('ru', 'statistics', 'Статистика');
SELECT add_translation_key('ru', 'users', 'Пользователи');
SELECT add_translation_key('ru', 'yes', 'Да');
SELECT add_translation_key('ru', 'forum_title', 'Форум сообщества');
SELECT add_translation_key('ru', 'forum_new_post', 'Новый пост');
SELECT add_translation_key('ru', 'create_listing', 'Создать объявление');
SELECT add_translation_key('ru', 'contact_sharer', 'Связаться');

-- Japanese (ja)
SELECT add_translation_key('ja', 'ab_testing', 'A/Bテスト');
SELECT add_translation_key('ja', 'about', 'について');
SELECT add_translation_key('ja', 'account', 'アカウント');
SELECT add_translation_key('ja', 'analytics', '分析');
SELECT add_translation_key('ja', 'challenges', 'チャレンジ');
SELECT add_translation_key('ja', 'dashboard', 'ダッシュボード');
SELECT add_translation_key('ja', 'explore', '探索');
SELECT add_translation_key('ja', 'listings', 'リスト');
SELECT add_translation_key('ja', 'overview', '概要');
SELECT add_translation_key('ja', 'reports', 'レポート');
SELECT add_translation_key('ja', 'send', '送信');
SELECT add_translation_key('ja', 'statistics', '統計');
SELECT add_translation_key('ja', 'users', 'ユーザー');
SELECT add_translation_key('ja', 'yes', 'はい');
SELECT add_translation_key('ja', 'forum_title', 'コミュニティフォーラム');
SELECT add_translation_key('ja', 'forum_new_post', '新規投稿');
SELECT add_translation_key('ja', 'create_listing', 'リストを作成');
SELECT add_translation_key('ja', 'contact_sharer', '連絡する');

-- Chinese (zh)
SELECT add_translation_key('zh', 'ab_testing', 'A/B测试');
SELECT add_translation_key('zh', 'about', '关于');
SELECT add_translation_key('zh', 'account', '账户');
SELECT add_translation_key('zh', 'analytics', '分析');
SELECT add_translation_key('zh', 'challenges', '挑战');
SELECT add_translation_key('zh', 'dashboard', '仪表板');
SELECT add_translation_key('zh', 'explore', '探索');
SELECT add_translation_key('zh', 'listings', '列表');
SELECT add_translation_key('zh', 'overview', '概览');
SELECT add_translation_key('zh', 'reports', '报告');
SELECT add_translation_key('zh', 'send', '发送');
SELECT add_translation_key('zh', 'statistics', '统计');
SELECT add_translation_key('zh', 'users', '用户');
SELECT add_translation_key('zh', 'yes', '是');
SELECT add_translation_key('zh', 'forum_title', '社区论坛');
SELECT add_translation_key('zh', 'forum_new_post', '新帖子');
SELECT add_translation_key('zh', 'create_listing', '创建列表');
SELECT add_translation_key('zh', 'contact_sharer', '联系分享者');

-- Korean (ko)
SELECT add_translation_key('ko', 'ab_testing', 'A/B 테스트');
SELECT add_translation_key('ko', 'about', '정보');
SELECT add_translation_key('ko', 'account', '계정');
SELECT add_translation_key('ko', 'analytics', '분석');
SELECT add_translation_key('ko', 'challenges', '챌린지');
SELECT add_translation_key('ko', 'dashboard', '대시보드');
SELECT add_translation_key('ko', 'explore', '탐색');
SELECT add_translation_key('ko', 'listings', '목록');
SELECT add_translation_key('ko', 'overview', '개요');
SELECT add_translation_key('ko', 'reports', '보고서');
SELECT add_translation_key('ko', 'send', '보내기');
SELECT add_translation_key('ko', 'statistics', '통계');
SELECT add_translation_key('ko', 'users', '사용자');
SELECT add_translation_key('ko', 'yes', '예');
SELECT add_translation_key('ko', 'forum_title', '커뮤니티 포럼');
SELECT add_translation_key('ko', 'forum_new_post', '새 게시물');
SELECT add_translation_key('ko', 'create_listing', '목록 만들기');
SELECT add_translation_key('ko', 'contact_sharer', '공유자에게 연락');

-- Arabic (ar)
SELECT add_translation_key('ar', 'ab_testing', 'اختبار A/B');
SELECT add_translation_key('ar', 'about', 'حول');
SELECT add_translation_key('ar', 'account', 'الحساب');
SELECT add_translation_key('ar', 'analytics', 'التحليلات');
SELECT add_translation_key('ar', 'challenges', 'التحديات');
SELECT add_translation_key('ar', 'dashboard', 'لوحة التحكم');
SELECT add_translation_key('ar', 'explore', 'استكشف');
SELECT add_translation_key('ar', 'listings', 'القوائم');
SELECT add_translation_key('ar', 'overview', 'نظرة عامة');
SELECT add_translation_key('ar', 'reports', 'التقارير');
SELECT add_translation_key('ar', 'send', 'إرسال');
SELECT add_translation_key('ar', 'statistics', 'الإحصائيات');
SELECT add_translation_key('ar', 'users', 'المستخدمون');
SELECT add_translation_key('ar', 'yes', 'نعم');
SELECT add_translation_key('ar', 'forum_title', 'منتدى المجتمع');
SELECT add_translation_key('ar', 'forum_new_post', 'منشور جديد');
SELECT add_translation_key('ar', 'create_listing', 'إنشاء قائمة');
SELECT add_translation_key('ar', 'contact_sharer', 'اتصل بالمشارك');

-- Drop the helper function
DROP FUNCTION IF EXISTS add_translation_key(TEXT, TEXT, TEXT);
