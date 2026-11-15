<?php
/**
 * Plugin Name: BDS REST SEO Meta
 * Description: Открывает мета-поля Yoast SEO для записи через WP REST API. Нужен автопубликации новостей Stack Radar и сайтов-спутников.
 * Version: 1.0.0
 * Author: BigDataSchool
 *
 * Исходник с bigdataschool.ru (правился на сервере, в git не лежал), положен в bds-satellites 2026-11-03
 * с тремя правками автора:
 * 1. Без sanitize_callback: он отключал валидацию Yoast везде, включая админку. Yoast санитизирует сам.
 * 2. _yoast_wpseo_primary_category — integer: строка давала 400 на числовой ID уже после создания записи,
 *    а повтор плодил дубль. Принимает и 12, и "12". Главная рубрика выбирается только из categories
 *    записи, поэтому categories и primary_category идут одним запросом.
 * 3. Без rocket_clean_post(): страничный кэш держит nginx, кэш страниц WP Rocket выключен.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Поля Yoast, которые открываем на запись через REST.
 * Ключи защищённые (начинаются с подчёркивания), поэтому без auth_callback
 * REST их молча игнорирует.
 */
define(
	'BDS_REST_SEO_META_KEYS',
	array(
		'_yoast_wpseo_title',
		'_yoast_wpseo_metadesc',
		'_yoast_wpseo_focuskw',
		'_yoast_wpseo_canonical',
		'_yoast_wpseo_primary_category',
		'_yoast_wpseo_opengraph-title',
		'_yoast_wpseo_opengraph-description',
		'_yoast_wpseo_meta-robots-noindex',
	)
);

/**
 * Типы записей, у которых открываем поля.
 * Расширяется фильтром, чтобы добавить CPT encyclopedia не правя файл:
 *   add_filter( 'bds_rest_seo_meta_post_types', fn( $t ) => array_merge( $t, array( 'encyclopedia' ) ) );
 */
function bds_rest_seo_meta_post_types() {
	return apply_filters( 'bds_rest_seo_meta_post_types', array( 'post' ) );
}

/**
 * Кто имеет право писать эти поля: тот же, кто может править саму запись.
 */
function bds_rest_seo_meta_auth( $allowed, $meta_key, $post_id ) {
	return current_user_can( 'edit_post', $post_id );
}

add_action(
	'init',
	function () {
		foreach ( bds_rest_seo_meta_post_types() as $post_type ) {
			foreach ( BDS_REST_SEO_META_KEYS as $key ) {
				$is_int = '_yoast_wpseo_primary_category' === $key;
				register_post_meta(
					$post_type,
					$key,
					array(
						'type'          => $is_int ? 'integer' : 'string',
						'single'        => true,
						'default'       => $is_int ? 0 : '',
						'show_in_rest'  => true,
						'auth_callback' => 'bds_rest_seo_meta_auth',
					)
				);
			}
			add_action( "rest_after_insert_{$post_type}", 'bds_rest_seo_meta_touch', 20, 2 );
		}
	},
	20
);

/**
 * Yoast собирает свой indexable на wp_insert_post, а REST пишет meta уже после
 * этого. Без повторного сохранения в индексе остаётся title без нашей меты, и на
 * странице виден старый заголовок при верной строке в postmeta.
 * Дёргаем запись ещё раз, когда meta уже на месте.
 */
function bds_rest_seo_meta_touch( $post, $request ) {
	static $busy = false;

	if ( $busy ) {
		return;
	}

	$meta = $request->get_param( 'meta' );
	if ( empty( $meta ) || ! is_array( $meta ) ) {
		return;
	}
	if ( ! array_intersect( array_keys( $meta ), BDS_REST_SEO_META_KEYS ) ) {
		return;
	}

	$busy = true;
	clean_post_cache( $post->ID );
	wp_update_post( array( 'ID' => $post->ID ) );

	$busy = false;
}
