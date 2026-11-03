require 'json'
require 'rubygems/installer'

directory = ARGV.fetch(0)
directory = Gem.default_dir if directory.empty?
packages = JSON.parse(ARGV.fetch(1))

# Inspect every verified package before changing the installation directory.
installers = packages.map do |entry|
  installer = Gem::Installer.at(entry.fetch('file'), install_dir: directory,
    ignore_dependencies: true, document: [], wrappers: false)
  spec = installer.spec
  unless spec.name == entry.fetch('name') && spec.version.to_s == entry.fetch('version')
    raise "gem identity が固定情報と一致しません: #{entry.fetch('file')}"
  end
  # Prebuilt gems for another platform are refused; C extensions are built for this Ruby.
  raise "別のplatform向けのgemは同梱対象外です: #{spec.full_name}" unless spec.platform == Gem::Platform::RUBY
  installer
end
# A C extension may use its dependency's headers (lbfgsb uses numo-narray's), so dependencies come first.
names = installers.map { |installer| installer.spec.name }
installers.each_with_index do |installer, index|
  later = installer.spec.runtime_dependencies.map(&:name) & names.drop(index + 1)
  raise "#{later.join(', ')}を#{installer.spec.name}より先に並べてください" unless later.empty?
end
installers.each do |installer|
  spec = installer.install
  puts "Installed #{spec.full_name} into #{directory}"
end
