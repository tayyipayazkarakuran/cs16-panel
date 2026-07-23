FROM php:8.2-apache

RUN docker-php-ext-install mysqli pdo_mysql

RUN a2enmod rewrite

# docker-php.conf has its own <Directory /var/www/> block with Options -Indexes
# which overrides apache2.conf. Fix it here.
RUN sed -i 's/Options -Indexes/Options +Indexes/' /etc/apache2/conf-enabled/docker-php.conf

# Auto-prepend: session-based port tracking + output buffer URL rewrite
RUN echo 'auto_prepend_file = /var/www/html/.prepend.php' >> /usr/local/etc/php/conf.d/panel.ini

# Create /var/www/html/servers directory and set permissions
RUN mkdir -p /var/www/html/servers \
 && chown -R www-data:www-data /var/www/html
