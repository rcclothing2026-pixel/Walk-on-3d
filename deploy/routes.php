<?php

/*
|--------------------------------------------------------------------------
| Virtual tour route
|--------------------------------------------------------------------------
|
| Add this to routes/web.php in the Laravel app.
|
| The tour is a static bundle sitting in public/tour/, so LiteSpeed serves
| public/tour/index.html directly for /tour/ without Laravel being involved at
| all. This route exists only for the tidier /tour URL (no trailing slash) and
| to give the page a name you can link to with route('tour').
|
| Deep links are query strings — /tour?node=17 — so there is nothing to route:
| the viewer reads ?node itself. Do NOT add a /tour/{node} path route; it would
| shadow the static assets under public/tour/.
|
*/

use Illuminate\Support\Facades\Route;

Route::get('/tour', function () {
    $index = public_path('tour/index.html');

    abort_unless(file_exists($index), 404, 'The tour bundle has not been deployed yet.');

    return response()->file($index, [
        'Content-Type' => 'text/html; charset=utf-8',
        // Matches the .htaccess policy: the entry point must revalidate so a
        // deploy is picked up immediately.
        'Cache-Control' => 'no-cache, must-revalidate',
    ]);
})->name('tour');
