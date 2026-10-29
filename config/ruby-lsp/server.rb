# The parent removes Ruby startup variables before launching this file.
ENV.keys.grep(/\ABUNDLE_/).each { |key| ENV.delete(key) }
%w[RUBYOPT RUBYLIB GEM_HOME GEM_PATH].each { |key| ENV.delete(key) }
root = File.expand_path(__dir__)
Gem.use_paths(File.join(root, 'gems'), [File.join(root, 'gems'), Gem.default_dir])
ENV['BUNDLE_GEMFILE'] = File.join(root, 'Gemfile')
ENV['BUNDLE_IGNORE_CONFIG'] = 'true'
ENV['BUNDLE_FROZEN'] = 'true'
require 'bundler/setup'

if ARGV.delete('--probe')
  require 'json'
  require 'prism'
  require 'rbs'
  puts JSON.generate(Gem.loaded_specs.transform_values { |spec| spec.version.to_s })
else
  load Gem.bin_path('ruby-lsp', 'ruby-lsp')
end
