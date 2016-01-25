var Client = require('@sourcebox/web');

var client = new Client('https://sourceboxserver', {
  auth: {
    username: 'username',
    password: 'password'
  }
});

client.readFile('/etc/hosts', 'utf8')
  .then(window.alert)
  .catch(window.alert);
