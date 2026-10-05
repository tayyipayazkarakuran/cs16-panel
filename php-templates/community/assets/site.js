document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
        var value = button.getAttribute('data-copy');
        var done = function () {
            var original = button.textContent;
            button.textContent = 'Kopyalandı ✓';
            setTimeout(function () { button.textContent = original; }, 1500);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(value).then(done);
        else { window.prompt('IP adresi:', value); }
    });
});
