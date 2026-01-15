-- Migration: Add forum category translation keys
-- This migration adds translation keys for forum categories to support localization
-- Keys follow the pattern: forum.category.{slug}

-- Add forum category translations for all locales
DO $$
DECLARE
  forum_category_keys_en jsonb := '{"forum":{"category":{"announcements":"Announcements","general":"General","general-discussion":"General Discussion","tips-tricks":"Tips & Tricks","tips":"Tips","recipes":"Recipes","community":"Community","questions":"Questions","guides":"Guides","help":"Help","feedback":"Feedback","introductions":"Introductions","events":"Events","success-stories":"Success Stories","food-safety":"Food Safety","sustainability":"Sustainability"}}}'::jsonb;

  forum_category_keys_ru jsonb := '{"forum":{"category":{"announcements":"Объявления","general":"Общее","general-discussion":"Общее обсуждение","tips-tricks":"Советы и хитрости","tips":"Советы","recipes":"Рецепты","community":"Сообщество","questions":"Вопросы","guides":"Руководства","help":"Помощь","feedback":"Отзывы","introductions":"Знакомства","events":"События","success-stories":"Истории успеха","food-safety":"Безопасность еды","sustainability":"Устойчивость"}}}'::jsonb;

  forum_category_keys_de jsonb := '{"forum":{"category":{"announcements":"Ankuendigungen","general":"Allgemein","general-discussion":"Allgemeine Diskussion","tips-tricks":"Tipps und Tricks","tips":"Tipps","recipes":"Rezepte","community":"Gemeinschaft","questions":"Fragen","guides":"Anleitungen","help":"Hilfe","feedback":"Feedback","introductions":"Vorstellungen","events":"Veranstaltungen","success-stories":"Erfolgsgeschichten","food-safety":"Lebensmittelsicherheit","sustainability":"Nachhaltigkeit"}}}'::jsonb;

  forum_category_keys_es jsonb := '{"forum":{"category":{"announcements":"Anuncios","general":"General","general-discussion":"Discusion General","tips-tricks":"Consejos y Trucos","tips":"Consejos","recipes":"Recetas","community":"Comunidad","questions":"Preguntas","guides":"Guias","help":"Ayuda","feedback":"Comentarios","introductions":"Presentaciones","events":"Eventos","success-stories":"Historias de Exito","food-safety":"Seguridad Alimentaria","sustainability":"Sostenibilidad"}}}'::jsonb;

  forum_category_keys_fr jsonb := '{"forum":{"category":{"announcements":"Annonces","general":"General","general-discussion":"Discussion Generale","tips-tricks":"Trucs et Astuces","tips":"Conseils","recipes":"Recettes","community":"Communaute","questions":"Questions","guides":"Guides","help":"Aide","feedback":"Retours","introductions":"Presentations","events":"Evenements","success-stories":"Histoires de Reussite","food-safety":"Securite Alimentaire","sustainability":"Durabilite"}}}'::jsonb;

  forum_category_keys_uk jsonb := '{"forum":{"category":{"announcements":"Оголошення","general":"Загальне","general-discussion":"Загальне обговорення","tips-tricks":"Поради та хитрощі","tips":"Поради","recipes":"Рецепти","community":"Спільнота","questions":"Питання","guides":"Посібники","help":"Допомога","feedback":"Відгуки","introductions":"Знайомства","events":"Події","success-stories":"Історії успіху","food-safety":"Безпека їжі","sustainability":"Сталість"}}}'::jsonb;

BEGIN
  -- Update English
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_en), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'en';
  RAISE NOTICE 'Updated English forum category translations';

  -- Update Russian
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_ru), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'ru';
  RAISE NOTICE 'Updated Russian forum category translations';

  -- Update German
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_de), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'de';
  RAISE NOTICE 'Updated German forum category translations';

  -- Update Spanish
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_es), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'es';
  RAISE NOTICE 'Updated Spanish forum category translations';

  -- Update French
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_fr), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'fr';
  RAISE NOTICE 'Updated French forum category translations';

  -- Update Ukrainian
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_uk), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale = 'uk';
  RAISE NOTICE 'Updated Ukrainian forum category translations';

  -- For remaining locales, use English as fallback
  UPDATE translations SET messages = deep_merge_jsonb(messages, forum_category_keys_en), version = to_char(now(), 'YYYYMMDDHH24MISS'), updated_at = now() WHERE locale NOT IN ('en', 'ru', 'de', 'es', 'fr', 'uk');
  RAISE NOTICE 'Updated remaining locales with English fallback';
END $$;
