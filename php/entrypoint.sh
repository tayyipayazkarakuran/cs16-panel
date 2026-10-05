#!/bin/sh
set -e
# The web root is a bind mount, so create the panel-managed layout at runtime.
mkdir -p /var/www/html/servers /var/www/html/.sites-data /var/www/html/.panel
[ -f /var/www/html/.panel/domains.map ] || echo "# domain port" > /var/www/html/.panel/domains.map
chown www-data:www-data /var/www/html/servers /var/www/html/.sites-data
exec apache2-foreground
