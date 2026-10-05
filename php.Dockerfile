# CS 1.6 panel — multi-tenant PHP 8.2 website host (Apache + mod_php)
FROM php:8.2-apache

RUN apt-get update \
 && apt-get install -y --no-install-recommends libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev libonig-dev libicu-dev \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j"$(nproc)" mysqli pdo_mysql zip gd mbstring intl exif opcache bcmath \
 && apt-get purge -y --auto-remove \
 && rm -rf /var/lib/apt/lists/*

RUN a2enmod rewrite headers expires deflate

COPY php/panel-php.ini /usr/local/etc/php/conf.d/zz-panel.ini
COPY php/panel-prepend.php /usr/local/etc/php/panel-prepend.php
COPY php/apache-vhost.conf /etc/apache2/sites-available/000-default.conf
COPY php/entrypoint.sh /usr/local/bin/panel-php-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/panel-php-entrypoint \
 && chmod 0755 /usr/local/bin/panel-php-entrypoint \
 && chmod 0644 /usr/local/etc/php/panel-prepend.php \
 && apache2ctl -t

CMD ["panel-php-entrypoint"]
