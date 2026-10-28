require 'json'
require 'bigdecimal'
require 'openssl'
require 'prime'
require 'rexml/document'
require 'pairing_heap'
require 'ac-library-rb/dsu'
require 'bitarray'
require 'faster_prime'
require 'rgl/adjacency'
require 'rgl/topsort'
require 'sorted_containers'

puts RUBY_VERSION
%w[prime rexml pairing_heap stream ac-library-rb bitarray faster_prime rgl sorted_containers].each do |name|
  puts "#{name}:#{Gem.loaded_specs.fetch(name).version}"
end
dsu = AcLibraryRb::DSU.new(4)
dsu.merge(0, 2)
puts dsu.same?(0, 2)
puts FasterPrime.prime?(1_000_000_007)
bits = BitArray.new(8)
bits[3] = 1
puts bits.to_s
graph = RGL::DirectedAdjacencyGraph[0, 1, 1, 2]
puts graph.topsort_iterator.to_a.join(',')
puts SortedContainers::SortedArray.new([3, 1, 2]).to_a.join(',')
puts JSON.generate(value: BigDecimal('1.5').to_s('F'), input: STDIN.read.chomp)
